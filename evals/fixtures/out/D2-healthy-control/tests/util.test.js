import { sum, clamp } from "../src/util.js";
test("sum", () => expect(sum(1, 2)).toBe(3));
test("clamp", () => expect(clamp(5, 0, 3)).toBe(3));
