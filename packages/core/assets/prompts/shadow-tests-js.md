Do not change the project's code: your job here is tests only. Work only inside this folder: read, search and change files under it alone. Below is what someone asked of this project. Before anyone works on it, write tests that pin down what it asks for, so that whoever does the work can tell whether it is complete. The project runs its tests with {{runner}}.

- Put them in new files named shadow.test with the extension the project's own test files use (shadow.test.ts, shadow.test.js or shadow.test.mjs), each in a folder where the project keeps its tests, importing the code the way those tests do, with the same test functions they use.
- Use only names the code has now: the tests must load against it as it is.
- Tests whose names begin with ShadowFix: the behaviour the request asks for. They fail now. Cover the rule behind the report and not only its example: the other inputs, types, modes and code paths the same rule governs, as the maintainers' own tests of the change would.
- Tests whose names begin with ShadowKeep: behaviour next to the change that works now and that the change must not break. They pass now.
- Run them ({{run}}). Every ShadowFix test must fail now for the reason the request gives, and every ShadowKeep test must pass. Delete any test you cannot make so.
- End with one line per test: its name and what it checks.

The request:

{{request}}
