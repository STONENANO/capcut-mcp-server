/**
 * Static audit of the shipped source.
 *
 * Requirements 1 and 4 are properties of the codebase, not of any one call:
 * there must be no HTTP transport to start, and no path from a tool to a shell.
 * Asserting on the source keeps a future edit from quietly reintroducing either.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

const SRC_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src');

async function sourceFiles(dir: string = SRC_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

async function readAllSources(): Promise<Array<{ file: string; text: string }>> {
  const files = await sourceFiles();
  return Promise.all(
    files.map(async file => ({
      file: path.relative(SRC_DIR, file),
      text: await readFile(file, 'utf8'),
    }))
  );
}

describe('no command execution anywhere in the runtime', () => {
  test('the source never imports a process-spawning module', async () => {
    const forbidden = [
      /from ['"]node:child_process['"]/,
      /from ['"]child_process['"]/,
      /require\(['"](node:)?child_process['"]\)/,
      /from ['"]node:vm['"]/,
      /from ['"]node:worker_threads['"]/,
    ];
    for (const { file, text } of await readAllSources()) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(text, pattern, `${file} must not import a process/eval module`);
      }
    }
  });

  test('the source never calls exec, spawn, eval or the Function constructor', async () => {
    const forbidden = [
      /\bexecSync\s*\(/,
      /\bexecFileSync\s*\(/,
      /\bspawnSync\s*\(/,
      /\bexecFile\s*\(/,
      /(?<![.\w])exec\s*\(/,
      /(?<![.\w])spawn\s*\(/,
      /(?<![.\w])eval\s*\(/,
      /new\s+Function\s*\(/,
      /shell\s*:\s*true/,
    ];
    for (const { file, text } of await readAllSources()) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(text, pattern, `${file} must not execute code (${pattern})`);
      }
    }
  });

  test('the built entrypoint has no child_process reference either', async () => {
    const built = path.resolve(SRC_DIR, '..', 'dist-test', 'src', 'index.js');
    const text = await readFile(built, 'utf8').catch(() => '');
    assert.notEqual(text, '', 'the entrypoint should be compiled before this test runs');
    assert.doesNotMatch(text, /child_process/);
  });
});

describe('no HTTP transport', () => {
  test('the source never imports an HTTP server or MCP HTTP transport', async () => {
    const forbidden = [
      /streamableHttp/i,
      /SSEServerTransport/,
      /from ['"]express['"]/,
      /from ['"]node:http['"]/,
      /from ['"]node:https['"]/,
      /from ['"]node:net['"]/,
      /createServer\s*\(/,
      /\.listen\s*\(/,
    ];
    for (const { file, text } of await readAllSources()) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(text, pattern, `${file} must not start a listener (${pattern})`);
      }
    }
  });

  test('the entrypoint connects stdio and nothing else', async () => {
    const index = await readFile(path.join(SRC_DIR, 'index.ts'), 'utf8');
    assert.match(index, /StdioServerTransport/);
    const connects = index.match(/server\.connect\(/g) ?? [];
    assert.equal(connects.length, 1, 'exactly one transport may be connected');
  });

  test('TRANSPORT and PORT are no longer honoured', async () => {
    for (const { file, text } of await readAllSources()) {
      assert.doesNotMatch(
        text,
        /process\.env\.(TRANSPORT|PORT)\b/,
        `${file} must not read a transport/port variable`
      );
    }
  });

  test('express is not a declared dependency of this package', async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(SRC_DIR, '..', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    assert.equal('express' in manifest.dependencies, false);
    assert.equal('@types/express' in manifest.devDependencies, false);
  });
});

describe('dependency pinning', () => {
  test('every declared dependency is an exact version', async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(SRC_DIR, '..', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

    for (const [name, range] of [
      ...Object.entries(manifest.dependencies),
      ...Object.entries(manifest.devDependencies),
    ]) {
      assert.match(
        range,
        /^\d+\.\d+\.\d+(-[\w.]+)?$/,
        `${name} is pinned to ${range}; use an exact version`
      );
    }
  });

  test('a lockfile is committed', async () => {
    const lock = await readFile(path.resolve(SRC_DIR, '..', 'package-lock.json'), 'utf8');
    assert.ok(lock.length > 0);
  });
});

describe('logging hygiene', () => {
  test('nothing logs the environment or writes protocol noise to stdout', async () => {
    for (const { file, text } of await readAllSources()) {
      assert.doesNotMatch(text, /console\.log\s*\(/, `${file} must not write to stdout`);
      assert.doesNotMatch(
        text,
        /(JSON\.stringify\(\s*process\.env|console\.\w+\(\s*process\.env)/,
        `${file} must not log the environment`
      );
    }
  });

  test('the startup line reports directory presence, not directory paths', async () => {
    const index = await readFile(path.join(SRC_DIR, 'index.ts'), 'utf8');
    assert.match(index, /draftDir=\$\{config\.draftDir \? 'configured' : 'unset'\}/);
    assert.match(index, /mediaDirs=\$\{config\.mediaDirs\.length\}/);
  });
});
