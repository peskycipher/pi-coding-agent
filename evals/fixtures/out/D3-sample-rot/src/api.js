export function createClient({ baseUrl, timeout = 1000 } = {}) {
  return { baseUrl, timeout };
}
