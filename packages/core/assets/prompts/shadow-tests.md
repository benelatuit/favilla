Do not change the project's code: your job here is tests only. Work only inside this folder: read, search and change files under it alone. Below is what someone asked of this project. Before anyone works on it, write Go tests that pin down what it asks for, so that whoever does the work can tell whether it is complete.

- Put them in new files named shadow_test.go, one in each package you test, in the package of the code they test (internal tests, so unexported names can be used).
- Use only names that exist in the code now: the tests must compile against it as it is.
- Tests named TestShadowFix...: the behaviour the request asks for. They fail now. Cover the rule behind the report and not only its example: the other inputs, types, modes and code paths the same rule governs, as the maintainers' own tests of the change would.
- Tests named TestShadowKeep...: behaviour next to the change that works now and that the change must not break. They pass now.
- Run them. Every TestShadowFix test must fail now for the reason the request gives, and every TestShadowKeep test must pass. Delete any test you cannot make so.
- End with one line per test: its name and what it checks.

The request:

{{request}}
