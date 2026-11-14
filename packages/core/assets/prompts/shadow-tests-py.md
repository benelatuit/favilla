Do not change the project's code: your job here is tests only. Work only inside this folder: read, search and change files under it alone. Below is what someone asked of this project. Before anyone works on it, write pytest tests that pin down what it asks for, so that whoever does the work can tell whether it is complete.

- Put them in new files named test_shadow.py, each in a folder where the project keeps its tests, importing the code the way those tests do.
- Use only names the code has now: the tests must import against it as it is.
- Test functions named test_shadow_fix_...: the behaviour the request asks for. They fail now. Cover the rule behind the report and not only its example: the other inputs, types, modes and code paths the same rule governs, as the maintainers' own tests of the change would.
- Test functions named test_shadow_keep_...: behaviour next to the change that works now and that the change must not break. They pass now.
- Run them ({{run}}). Every test_shadow_fix_ test must fail now for the reason the request gives, and every test_shadow_keep_ test must pass. Delete any test you cannot make so.
- End with one line per test: its name and what it checks.

The request:

{{request}}
