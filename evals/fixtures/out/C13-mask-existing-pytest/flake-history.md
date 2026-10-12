# Flake history

`test_race.py::test_settles_eventually` was previously `flaky`. The prior fix raised its
timeout 30x instead of resolving the race: a masking candidate, not a repair.
