import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { Pool } from 'pg';

loadDotEnv({ path: resolve(process.cwd(), '.env') });

const databaseUrl = process.env.RESERVEFLOW_EXPERIMENT_DATABASE_URL;
if (!databaseUrl) throw new Error('Set RESERVEFLOW_EXPERIMENT_DATABASE_URL to a disposable database ending in _test or _experiment.');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run experiments in production.');
const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/(?:_test|_experiment)$/.test(dbName)) throw new Error('Refusing to run experiments unless the database name ends in _test or _experiment.');

const mode = process.env.RESERVEFLOW_EXPERIMENT_MODE === 'final' ? 'final' : 'pilot';
const trials = mode === 'final' ? 30 : 5;
const operationsPerTrial = mode === 'final' ? 100 : 32;
const concurrencyLevels = [1, 2, 8, 16];
const variants = ['unsafe-read-check-write', 'transaction-without-budget-lock', 'transaction-with-budget-lock'] as const;
type Variant = typeof variants[number];
type Row = { id: number; limit_minor: string; reserved_minor: string };

function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await gate;
  };
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 24, connectionTimeoutMillis: 4_000, application_name: 'reserveflow-concurrency-experiment' });
  const schema = `rfexp_${randomUUID().replaceAll('-', '')}`;
  const quotedSchema = `"${schema}"`;
  const results: Record<string, unknown>[] = [];
  const startedAt = new Date();
  try {
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    // This deliberately isolated experiment schema omits budget CHECK constraints so that
    // application-level races are observable. It is never used by the ReserveFlow app.
    await pool.query(`CREATE TABLE ${quotedSchema}.budgets (id integer PRIMARY KEY, limit_minor bigint NOT NULL, reserved_minor bigint NOT NULL)`);
    await pool.query(`CREATE TABLE ${quotedSchema}.reservations (operation_id text PRIMARY KEY, amount_minor bigint NOT NULL)`);

    for (const variant of variants) {
      for (const concurrency of concurrencyLevels) {
        for (let trial = 1; trial <= trials; trial += 1) {
          await pool.query(`TRUNCATE ${quotedSchema}.reservations`);
          await pool.query(`INSERT INTO ${quotedSchema}.budgets(id, limit_minor, reserved_minor) VALUES (1, 100000, 0)`);
          const latencies: number[] = [];
          let accepted = 0;
          let rejected = 0;
          let failures = 0;

          const execute = async (operationNumber: number, readBarrier?: () => Promise<void>) => {
            const client = await pool.connect();
            const operationId = `${variant}-${concurrency}-${trial}-${operationNumber}-${randomUUID()}`;
            const started = process.hrtime.bigint();
            try {
              if (variant !== 'unsafe-read-check-write') await client.query('BEGIN');
              const budgetQuery = variant === 'transaction-with-budget-lock'
                ? `SELECT id, limit_minor::text, reserved_minor::text FROM ${quotedSchema}.budgets WHERE id = 1 FOR UPDATE`
                : `SELECT id, limit_minor::text, reserved_minor::text FROM ${quotedSchema}.budgets WHERE id = 1`;
              const budgetResult = await client.query<Row>(budgetQuery);
              const budget = budgetResult.rows[0];
              if (!budget) throw new Error('Experiment budget row disappeared.');
              // All operations in an unlocked wave must rendezvous after reading.
              // Conditioning the barrier on an affordability check can deadlock a wave
              // if one client observes a newer committed balance than its peers.
              if (readBarrier) await readBarrier();
              if (BigInt(budget.limit_minor) - BigInt(budget.reserved_minor) < 70000n) {
                if (variant !== 'unsafe-read-check-write') await client.query('COMMIT');
                rejected += 1;
                return;
              }
              await client.query(`UPDATE ${quotedSchema}.budgets SET reserved_minor = reserved_minor + 70000 WHERE id = 1`);
              await client.query(`INSERT INTO ${quotedSchema}.reservations(operation_id, amount_minor) VALUES ($1, 70000)`, [operationId]);
              if (variant !== 'unsafe-read-check-write') await client.query('COMMIT');
              accepted += 1;
            } catch (error) {
              if (variant !== 'unsafe-read-check-write') {
                try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
              }
              failures += 1;
              if (error instanceof Error && process.env.RESERVEFLOW_EXPERIMENT_VERBOSE === '1') process.stderr.write(`${variant}: ${error.message}\n`);
            } finally {
              latencies.push(Number(process.hrtime.bigint() - started) / 1_000_000);
              client.release();
            }
          };

          for (let start = 0; start < operationsPerTrial; start += concurrency) {
            const waveSize = Math.min(concurrency, operationsPerTrial - start);
            const waveBarrier = variant === 'transaction-with-budget-lock' ? undefined : barrier(waveSize);
            await Promise.all(Array.from({ length: waveSize }, (_, index) => execute(start + index, waveBarrier)));
          }

          const state = await pool.query<{ limit_minor: string; reserved_minor: string; reservation_sum: string; reservation_count: string }>(`
            SELECT b.limit_minor::text, b.reserved_minor::text,
                   COALESCE(SUM(r.amount_minor), 0)::text AS reservation_sum,
                   COUNT(r.operation_id)::text AS reservation_count
            FROM ${quotedSchema}.budgets b LEFT JOIN ${quotedSchema}.reservations r ON true
            WHERE b.id = 1 GROUP BY b.id
          `);
          const final = state.rows[0]!;
          const limit = BigInt(final.limit_minor);
          const reserved = BigInt(final.reserved_minor);
          const reservationSum = BigInt(final.reservation_sum);
          results.push({
            timestamp: new Date().toISOString(), mode, variant, concurrency, trial,
            operations: operationsPerTrial, accepted, rejected, failures,
            overcommittedMinor: reserved > limit ? (reserved - limit).toString() : '0',
            reservationMismatchMinor: reserved >= reservationSum ? (reserved - reservationSum).toString() : (reservationSum - reserved).toString(),
            reservedMinor: reserved.toString(), reservationSumMinor: reservationSum.toString(), reservationCount: Number(final.reservation_count),
            latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(0, ...latencies) }
          });
        }
        process.stdout.write(`Finished ${variant}, concurrency ${concurrency}, ${trials} ${mode} trials.\n`);
      }
    }

    const outputDir = resolve(process.cwd(), 'experiments/results');
    await mkdir(outputDir, { recursive: true });
    const fileBase = `concurrency-${mode}-${startedAt.toISOString().replaceAll(':', '').replaceAll('.', '-')}`;
    const jsonlPath = resolve(outputDir, `${fileBase}.jsonl`);
    await writeFile(jsonlPath, `${results.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const reportPath = resolve(outputDir, `${fileBase}.md`);
    await writeFile(reportPath, buildReport(results, mode, trials, operationsPerTrial, startedAt), 'utf8');
    process.stdout.write(`Raw results: ${jsonlPath}\nReport: ${reportPath}\n`);
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`); } catch { /* keep primary result/error */ }
    await pool.end();
  }
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(3));
}

function buildReport(rows: Record<string, unknown>[], modeName: string, trialCount: number, operations: number, startedAt: Date) {
  const lines = [
    '# ReserveFlow concurrency experiment', '',
    `- Mode: ${modeName}`, `- Started: ${startedAt.toISOString()}`, `- Trials per configuration: ${trialCount}`,
    `- Operations per trial: ${operations}`, '- Budget limit: 100,000 minor units', '- Request amount: 70,000 minor units',
    '- Database: disposable schema inside a database explicitly suffixed `_test` or `_experiment`.',
    '- Important: unsafe baselines run only against an isolated schema without a budget-limit CHECK constraint.', '',
    '| Variant | Concurrency | Trials | Mean overcommit (minor) | Any overcommit trials | Mean accepted | Median latency ms | p95 latency ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const variant of variants) for (const concurrency of concurrencyLevels) {
    const group = rows.filter((row) => row.variant === variant && row.concurrency === concurrency);
    const totalOvercommit = group.reduce((sum, row) => sum + BigInt(String(row.overcommittedMinor)), 0n);
    const overcommitTrials = group.filter((row) => BigInt(String(row.overcommittedMinor)) > 0n).length;
    const meanAccepted = group.reduce((sum, row) => sum + Number(row.accepted), 0) / Math.max(group.length, 1);
    const medians = group.map((row) => Number((row.latencyMs as { median: number }).median));
    const p95s = group.map((row) => Number((row.latencyMs as { p95: number }).p95));
    lines.push(`| ${variant} | ${concurrency} | ${group.length} | ${(Number(totalOvercommit) / Math.max(group.length, 1)).toFixed(1)} | ${overcommitTrials} | ${meanAccepted.toFixed(2)} | ${percentile(medians, 0.5)} | ${percentile(p95s, 0.5)} |`);
  }
  lines.push('', '## Interpretation', '', 'These results describe this local synthetic workload only. The race baseline uses a deliberately unconstrained experimental table to expose the application-level read-check-write defect. It is not the production schema and must never be connected to the ReserveFlow API. The transactional unlocked variant demonstrates that a transaction alone does not serialize the initial balance read. The locked variant is expected to serialize requests for the same budget, but measured outcomes must be reviewed rather than assumed.', '', 'Review raw JSONL results, verify reservation totals independently, record host/container details, and rerun the experiment before using any metrics in a resume. No result should be claimed unless the run completed successfully.', '');
  return lines.join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`Experiment failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
