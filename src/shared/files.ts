import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function prepareOutputFiles(inputs: string[], outputs: string[], inputDescription: string): Promise<void> {
  const originals = await Promise.all(inputs.map((file) => realpath(file)));
  for (const output of outputs) {
    if (!output.trim()) throw new Error("Choose a nonempty output filename.");
    try {
      const destination = await realpath(output);
      if (originals.some((input) => path.relative(input, destination) === "")) throw new Error(`Choose an output different from the ${inputDescription}: ${output}.`);
      if (!(await stat(destination)).isFile()) throw new Error(`Output must be a file: ${output}.`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await mkdir(path.dirname(path.resolve(outputs[0])), { recursive: true });
}

/** On Windows a recently opened destination can briefly deny replacement. */
export async function publishFile(staged: string, destination: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await rename(staged, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(10 * 2 ** attempt, undefined, { signal });
    }
  }
}

/** Replace the destination only when the complete file is ready, including during concurrent writes. */
export async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  const part = `${file}.${randomUUID()}.part`;
  try {
    await writeFile(part, data);
    await publishFile(part, file);
  } finally {
    await rm(part, { force: true });
  }
}
