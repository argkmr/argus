# Local public-pricing simulation

This fixture models only the two public Markdown documents used by Argus's
credit-rate refresh. Its table and policy sentences follow the documented
format; **GPT-7 Future is fictional**, with synthetic rates 123 / 12.3 / 456
credits per million input / cached input / output tokens. It is deliberately
not listed as Fast-capable. GPT-6 Sol uses 50 / 5 / 250 in this fixture.

The owner's cloud mock search is intentionally skipped: this verification is
local-only, requires no login, and contains no account, repository or prompt data.

Run with Postman CLI 1.70+ (verified with 1.73.0), using an available explicit port:

```sh
postman simulation run postman/simulations/codex-public-rates.sim.yaml --port 4917 --output ndjson --no-history
```

The `listening` event confirms readiness. Both members are reachable only through
the local simulation:

- `http://127.0.0.1:4917/success/docs/pricing.md`
- `http://127.0.0.1:4917/success/docs/agent-configuration/speed.md`
- `http://127.0.0.1:4917/errors500/docs/pricing.md` (injected HTTP 500)

Use `postman request GET <url> --timeout 5000 --no-report-events` to inspect a
response. Other paths/methods on the success member return 501, not a fabricated
application response. Injected errors do not appear in the member request log.

The real Java integration test is enabled with
`-Dargus.rateSimulationUrl=http://127.0.0.1:4917` when running its targeted Maven
test. Logs and response captures belong in a temporary directory, not the repo.
Do not deploy, push, or connect this synthetic fixture to a user profile.

After verification, stop this exact simulation with:

```sh
pkill -INT -f 'simulation run postman/simulations/codex-public-rates.sim.yaml'
```
