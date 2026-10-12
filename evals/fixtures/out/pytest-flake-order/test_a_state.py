import pathlib
def test_a_seeds_shared_state():
    pathlib.Path("__state.sentinel").write_text("1")
