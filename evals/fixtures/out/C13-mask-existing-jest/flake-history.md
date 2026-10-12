# Flake history

`race.test.js::settles eventually` was previously `flaky`. The prior fix raised its
jest timeout 30x instead of resolving the race: a masking candidate, not a repair.
