export async function loadFixture<T>(name: string): Promise<T> {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(name, import.meta.url);
  const content = await readFile(url, "utf8");

  return JSON.parse(content) as T;
}
