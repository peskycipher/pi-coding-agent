import pathlib
def test_b_fails_only_after_a():
    if pathlib.Path("__state.sentinel").exists():
        raise AssertionError("shared-state order dependency: sentinel present")
