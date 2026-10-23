# sample-ai-saas (EVAL FIXTURE — intentionally vulnerable)

Seeded issues (see ../expected.json): two route handlers without auth
checks (CWE-862), a hardcoded API key (CWE-798), debug mode on (CWE-489),
and lodash 4.17.20 in the lockfile (stub-OSV fixture GHSA-35jh-r3h4-6jhm).
Do not deploy this. It exists so the eval harness can measure the Shield
pipeline deterministically.
