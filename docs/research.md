# Research notes: API correctness, database concurrency, and secure workflows

**Research cutoff for this initial bibliography: 10 October 2026.** This is a focused engineering review, not a systematic literature review. Publication status must be rechecked against the publisher record before an academic citation is used in formal work. The project does not claim scientific novelty.

## Research evidence

| ID | Work and status | Finding relevant to ReserveFlow | Scope limitation and use in this project |
|---|---|---|---|
| R1 | Hassan Sartaj, Shaukat Ali, Julie Marie Gjøby, “REST API Testing in DevOps: A Study on an Evolving Healthcare IoT Application.” ACM TOSEM journal paper; preprint [arXiv:2410.12547](https://arxiv.org/abs/2410.12547), DOI [10.1145/3765744](https://doi.org/10.1145/3765744). | Evaluates REST API testing tools across an evolving application and reports discovered faults and regressions; test volume can also create redundant work. | One healthcare/IoT application and restricted replication. API coverage does not prove a business invariant. ReserveFlow uses explicit state and budget assertions in addition to route coverage.
| R2 | Thomas Rooijakkers et al., “WuppieFuzz: Coverage-Guided, Stateful REST API Fuzzing.” [arXiv:2512.15554](https://arxiv.org/abs/2512.15554); ICISSP 2026 record [DOI 10.5220/0014327000004061](https://doi.org/10.5220/0014327000004061). | Stateful sequences and coverage feedback can explore behavior that isolated HTTP requests miss. | The cited evaluation target is not a financial workflow. The project uses controlled sequences and independent database-state checks, not a claim to reproduce the tool.
| R3 | Hexu Li et al., “Online Timestamp-based Transactional Isolation Checking of Database Systems (Extended Version).” 2025 arXiv manuscript [arXiv:2504.01477](https://arxiv.org/abs/2504.01477). | Illustrates the value of checking transaction histories against explicit isolation/correctness properties. | Database-engine instrumentation is outside this project. ReserveFlow checks its own operation history and business invariants instead of implementing a DBMS isolation checker.
| R4 | Huicong Xu et al., “Anomaly Pattern-guided Transaction Bug Testing in Relational Databases.” 2025 arXiv preprint [arXiv:2511.17377](https://arxiv.org/abs/2511.17377). | Transaction schedules generated from anomaly patterns can expose transactional defects in the evaluated database engines. | Results on the studied engines do not establish PostgreSQL application results. ReserveFlow uses small, application-level competing-request schedules.
| R5 | Yujia Fu et al., “Security Weaknesses of Copilot-Generated Code in GitHub Projects: An Empirical Study.” ACM TOSEM accepted manuscript [arXiv:2310.02059](https://arxiv.org/abs/2310.02059). | Generated code requires independent security review and validation; code that looks plausible is not proof of secure behavior. | Historical Python/JavaScript snippets do not estimate the defect rate of current models or this repository. The project uses explicit authorization tests and human review.
| R6 | Amirali Sajadi et al., “Do LLMs consider security? an empirical study on responses to programming questions.” Empirical Software Engineering (2025), [DOI 10.1007/s10664-025-10658-6](https://doi.org/10.1007/s10664-025-10658-6). | Security awareness in generated answers and explanations is an empirical question, not something to assume. | The task and model set are limited. ReserveFlow evaluates executable application behavior, not model security expertise.
| R7 | Nana Reinikainen, Mika Mäntylä, Yuqing Wang, “Assessing REST API Test Generation Strategies with Log Coverage.” EASE 2026 record; preprint [arXiv:2604.07073](https://arxiv.org/abs/2604.07073). | Different test-generation approaches can exercise complementary behaviors; log coverage is only a proxy for fault detection. | One main system and dependence on logging. ReserveFlow prioritizes invariant violations and known seeded defects, not log coverage alone.
| R8 | Tu Nguyen et al., “REST API Testing with Verified LLM-Inferred Dependencies and Response-Driven Refinement.” August 2026 arXiv preprint [arXiv:2608.17546](https://arxiv.org/abs/2608.17546). | Validating inferred request dependencies through execution can improve workflow construction. | Preprint results across 16 APIs do not prove authorization or financial rule correctness. ReserveFlow does not require an LLM; all business outcomes use explicit test oracles.

## Engineering references

- AWS Builders’ Library, [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): operation identity and business changes need a consistent atomic contract.
- Stripe, [Idempotent requests](https://docs.stripe.com/api/idempotent_requests): established behavior for duplicate requests and changed parameters.
- PostgreSQL, [Explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html): row locking and transaction behavior.
- PostgreSQL, [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html): isolation guarantees and anomalies.
- OWASP, [ASVS](https://owasp.org/www-project-application-security-verification-standard/) and [API Security Top 10](https://owasp.org/www-project-api-security/): security controls to translate into tests.

## Defensible project question

> Under a declared synthetic workload, how effectively does a transaction-based budget reservation implementation with budget-row serialization and atomic idempotency preserve financial workflow invariants during competing approvals, duplicate requests, and interrupted responses, and what local latency cost does it introduce?

This is an engineering evaluation of established techniques. It is not claimed to be an unsolved scientific problem or a novel transaction algorithm.

## Explicit limitations

The corpus is small and not exhaustive. Some works are preprints, and their publication metadata may change. Results may not generalize to PostgreSQL, this application, current coding assistants, commercial accounting software, or production traffic. No claim should be made from these sources without checking the exact paper and scope.
