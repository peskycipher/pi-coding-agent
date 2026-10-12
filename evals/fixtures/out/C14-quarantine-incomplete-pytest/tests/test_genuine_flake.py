import os

def test_genuine_seeded_flake():
    seed = int(os.environ.get("TEST_SEED", "7"))
    if seed % 5 == 2:
        raise AssertionError("seeded nondeterminism, seed=%d" % seed)
