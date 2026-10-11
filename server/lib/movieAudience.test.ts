import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import {
  AUDIENCE_MODEL,
  acceptedAudience,
  audienceInput,
  resolveMovieAudio,
} from '@server/lib/movieAudience';
import type { MovieAudioPolicy } from '@server/lib/movieAudioPolicy';
import type { RadarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';

const policy: MovieAudioPolicy = {
  enabled: true,
  kidsMode: 'family',
  ageCutoff: 12,
  missingRatingFallback: 'jev',
  profiles: [{ radarrServiceId: 0, kidsProfileId: 7, originalProfileId: 8 }],
  exceptions: [],
};
const servers = [{ id: 0, isDefault: true, is4k: false }] as RadarrSettings[];
const movie = (id: number, title = 'The Wild Robot'): TmdbMovieDetails =>
  ({
    id,
    title,
    overview: 'A robot cares for an orphaned goose.',
    adult: false,
    genres: [
      { id: 16, name: 'Animation' },
      { id: 10751, name: 'Family' },
    ],
    release_dates: { results: [] },
  }) as unknown as TmdbMovieDetails;
const high = (choice: 'kids' | 'older') => ({
  type: 'choice' as const,
  choice,
  confidence: 0.98,
  probabilities: {
    kids: choice === 'kids' ? 0.97 : 0.01,
    older: choice === 'older' ? 0.97 : 0.01,
    uncertain: 0.02,
  },
});
const response = (a = high('kids')) =>
  new Response(
    JSON.stringify({ model: AUDIENCE_MODEL, answers: { audience: a } }),
    { status: 200 }
  );

describe('Missing-rating audience routing', () => {
  let directory: string;
  const previousDirectory = process.env.CONFIG_DIRECTORY;
  const previousKey = process.env.TYPESAFE_API_KEY;
  before(async () => {
    const scratch =
      process.env.TMPDIR ?? path.join(homedir(), '.cache/agent-tmp');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(scratch, 'seerr-audience-'));
    process.env.CONFIG_DIRECTORY = directory;
    process.env.TYPESAFE_API_KEY = 'unit-test-placeholder';
  });
  afterEach(() => mock.restoreAll());
  after(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.CONFIG_DIRECTORY;
    else process.env.CONFIG_DIRECTORY = previousDirectory;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  });

  it('keeps exact ratings, explicit choices, exceptions and disabled policies authoritative without an API call', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('Unexpected call');
    });
    const rated = movie(1);
    rated.release_dates.results = [
      { iso_3166_1: 'PT', release_dates: [{ certification: 'M/12' }] },
    ] as TmdbMovieDetails['release_dates']['results'];
    assert.equal(
      (await resolveMovieAudio(rated, policy, servers)).profileId,
      8
    );
    assert.equal(
      (
        await resolveMovieAudio(movie(2), policy, servers, {
          preference: 'original',
        })
      ).profileId,
      8
    );
    assert.equal(
      (
        await resolveMovieAudio(
          movie(3),
          {
            ...policy,
            exceptions: [{ tmdbId: 3, preference: 'pt-PT', note: 'Pedro' }],
          },
          servers
        )
      ).profileId,
      7
    );
    assert.equal(
      (
        await resolveMovieAudio(
          movie(4),
          { ...policy, enabled: false },
          servers
        )
      ).enabled,
      false
    );
    assert.equal(
      (await resolveMovieAudio(movie(5), policy, servers, { serverId: 99 }))
        .preference,
      'review'
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('routes a strong kids judgment, caches it and re-evaluates changed evidence', async () => {
    const fetch = mock.method(
      globalThis,
      'fetch',
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, AUDIENCE_MODEL);
        assert.equal(body.questions.audience.type, 'choice');
        assert.deepEqual(Object.keys(body.questions.audience.criteria), [
          'kids',
          'older',
          'uncertain',
        ]);
        assert.equal(body.state.movie.tmdbId, 10);
        return response();
      }
    );
    const first = await resolveMovieAudio(movie(10), policy, servers);
    assert.equal(first.preference, 'pt-PT');
    assert.equal(first.profileId, 7);
    assert.equal(first.age, undefined);
    assert.equal(first.audience?.model, AUDIENCE_MODEL);
    await resolveMovieAudio(movie(10), policy, servers);
    assert.equal(fetch.mock.callCount(), 1);
    const changed = movie(10);
    changed.overview = 'Updated synopsis';
    await resolveMovieAudio(changed, policy, servers);
    assert.equal(fetch.mock.callCount(), 2);
    for (const f of await readdir(path.join(directory, 'movie-audience'))) {
      assert.ok(
        !(
          await readFile(path.join(directory, 'movie-audience', f), 'utf8')
        ).includes('unit-test-placeholder')
      );
    }
  });

  it('deduplicates concurrent previews and routes mature animation to original', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () =>
      response(high('older'))
    );
    const results = await Promise.all([
      resolveMovieAudio(movie(20, 'South Park'), policy, servers),
      resolveMovieAudio(movie(20, 'South Park'), policy, servers),
    ]);
    assert.ok(
      results.every((r) => r.preference === 'original' && r.profileId === 8)
    );
    assert.equal(fetch.mock.callCount(), 1);
  });

  it('holds uncertain, weak or invalid judgments instead of starting an original-language download', async () => {
    for (const [i, assessment] of [
      { ...high('kids'), choice: 'uncertain' },
      { ...high('kids'), confidence: 0.7 },
      {
        ...high('kids'),
        probabilities: { kids: 0.8, older: 0.1, uncertain: 0.1 },
      },
      {
        ...high('kids'),
        probabilities: { kids: 0.99, older: 0.99, uncertain: 0.01 },
      },
    ].entries()) {
      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            JSON.stringify({
              model: AUDIENCE_MODEL,
              answers: { audience: assessment },
            })
          )
      );
      const r = await resolveMovieAudio(movie(30 + i), policy, servers);
      assert.equal(r.preference, 'review');
      assert.equal(r.profileId, undefined);
      mock.restoreAll();
    }
    assert.equal(acceptedAudience(high('kids')), 'kids');
  });

  it('keeps failed providers and missing credentials in review without exposing their errors', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('Do not expose provider credential details');
    });
    const r = await resolveMovieAudio(movie(40), policy, servers);
    assert.equal(r.preference, 'review');
    assert.ok(!r.reason.includes('credential details'));
    delete process.env.TYPESAFE_API_KEY;
    assert.equal(
      (await resolveMovieAudio(movie(41), policy, servers)).profileId,
      undefined
    );
    process.env.TYPESAFE_API_KEY = 'unit-test-placeholder';
  });

  it('sends public movie evidence without private library fields', () => {
    const m = {
      ...movie(50),
      path: '/private/media',
      requestedBy: 'Pedro',
      apiKey: 'private',
    };
    const state = JSON.stringify(audienceInput(m));
    assert.ok(
      !state.includes('/private/media') &&
        !state.includes('Pedro') &&
        !state.includes('apiKey')
    );
  });
});
