import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { readGuide } from './guide';

const tempDir = join(tmpdir(), `pim-guide-test-${crypto.randomUUID()}`);
const environmentKeys = ['PIM_CONFIG', 'XDG_CONFIG_HOME'] as const;
const savedEnvironment = environmentKeys.map(
  (key) => [key, Bun.env[key]] as const,
);

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = value;
    }
  }
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const read = () => Effect.runPromise(Effect.result(readGuide));

describe('readGuide', () => {
  it('reads guide.md from the folder that PIM_CONFIG points into', async () => {
    const folder = join(tempDir, 'override');
    await Bun.write(join(folder, 'guide.md'), 'Sign off with "Best".\n');
    Bun.env.PIM_CONFIG = join(folder, 'accounts.toml');
    expect(await read()).toMatchObject({
      _tag: 'Success',
      success: {
        path: join(folder, 'guide.md'),
        guide: 'Sign off with "Best".\n',
      },
    });
  });

  it('reports a missing guide as null under XDG_CONFIG_HOME', async () => {
    Bun.env.PIM_CONFIG = '';
    Bun.env.XDG_CONFIG_HOME = tempDir;
    expect(await read()).toMatchObject({
      _tag: 'Success',
      success: { path: join(tempDir, 'pim', 'guide.md'), guide: null },
    });
  });

  it('fails with the path when the guide cannot be read', async () => {
    const folder = join(tempDir, 'unreadable');
    await mkdir(join(folder, 'guide.md'), { recursive: true });
    Bun.env.PIM_CONFIG = join(folder, 'accounts.toml');
    const result = await read();
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'ConfigError',
        message: expect.stringContaining(
          `Could not read the guide at ${join(folder, 'guide.md')}`,
        ),
      },
    });
  });
});
