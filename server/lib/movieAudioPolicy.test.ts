import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import type { MovieAudioPolicy } from '@server/lib/movieAudioPolicy';
import { decideMovieAudio } from '@server/lib/movieAudioPolicy';
import type { RadarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const policy: MovieAudioPolicy = {
  enabled: true,
  kidsMode: 'family',
  ageCutoff: 12,
  profiles: [{ radarrServiceId: 0, kidsProfileId: 7, originalProfileId: 8 }],
  exceptions: [
    { tmdbId: 803796, preference: 'pt-PT', note: 'KPop: Netflix Portugal 10+' },
  ],
};
const servers = [{ id: 0, isDefault: true, is4k: false }] as RadarrSettings[];
const movie = (
  certifications: string[],
  genres = [16],
  id = 1
): TmdbMovieDetails =>
  ({
    id,
    genres: genres.map((id) => ({ id, name: '' })),
    release_dates: {
      results: [
        {
          iso_3166_1: 'PT',
          release_dates: certifications.map((certification) => ({
            certification,
          })),
        },
      ],
    },
  }) as TmdbMovieDetails;

describe('Portugal movie audio policy', () => {
  it('routes children below 12 to strict PT-PT and the exact 12 boundary to original', () => {
    assert.equal(
      decideMovieAudio(movie(['M/6']), policy, servers).profileId,
      7
    );
    assert.equal(
      decideMovieAudio(movie(['M/12']), policy, servers).profileId,
      8
    );
    assert.equal(
      decideMovieAudio(movie(['M/18']), policy, servers).preference,
      'original'
    );
  });
  it('uses the stricter rating for differing editions', () => {
    assert.equal(
      decideMovieAudio(movie(['M/6', 'M/12']), policy, servers).preference,
      'original'
    );
  });
  it('does not equate foreign PG, missing or unrecognized ratings with below 12', () => {
    for (const cert of [[], [''], ['PG'], ['unknown']]) {
      const result = decideMovieAudio(movie(cert), policy, servers);
      assert.equal(result.preference, 'review');
      assert.equal(result.profileId, undefined);
    }
    const foreign = movie(['M/6']);
    foreign.release_dates.results[0].iso_3166_1 = 'BR';
    assert.equal(
      decideMovieAudio(foreign, policy, servers).preference,
      'review'
    );
  });
  it('handles KPop despite missing PT metadata and lets an explicit request choice win', () => {
    const kpop = movie([], [16], 803796);
    assert.equal(decideMovieAudio(kpop, policy, servers).preference, 'pt-PT');
    assert.equal(
      decideMovieAudio(kpop, policy, servers, { preference: 'original' })
        .profileId,
      8
    );
  });
  it('keeps low-rated non-children originals unless the all-movies option is selected', () => {
    assert.equal(
      decideMovieAudio(movie(['M/6'], [99]), policy, servers).preference,
      'original'
    );
    assert.equal(
      decideMovieAudio(
        movie(['M/6'], [99]),
        { ...policy, kidsMode: 'all' },
        servers
      ).preference,
      'pt-PT'
    );
  });
  it('holds requests for unconfigured destinations, including 4K', () => {
    assert.equal(
      decideMovieAudio(movie(['M/6']), policy, servers, { serverId: 5 })
        .preference,
      'review'
    );
    assert.equal(
      decideMovieAudio(movie(['M/6']), policy, servers, { is4k: true })
        .preference,
      'review'
    );
  });
});
