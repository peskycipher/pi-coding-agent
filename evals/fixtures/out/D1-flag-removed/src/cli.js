export function parseArgs(argv) {
  // --verbose was removed in v2; the flag now errors as unknown.
  return { flags: ["--help", "--output"], argv };
}
