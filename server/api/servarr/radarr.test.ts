import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import type {
  RadarrMovie,
  RadarrMovieOptions,
} from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('Radarr audio profile before search', () => {
  afterEach(() => mock.restoreAll());
  const options: RadarrMovieOptions = {
    title: 'Test',
    tmdbId: 1,
    year: 2026,
    qualityProfileId: 7,
    profileId: 7,
    minimumAvailability: 'released',
    tags: [],
    rootFolderPath: '/movies',
    monitored: true,
    searchNow: true,
    enforceAudioProfile: true,
  };
  it('updates an existing monitored movie before searching', async () => {
    const radarr = buildRadarr();
    const movie = {
      id: 9,
      title: 'Test',
      tags: [],
      monitored: true,
      hasFile: false,
      qualityProfileId: 1,
    } as unknown as RadarrMovie;
    mock.method(radarr, 'getMovieByTmdbId', async () => movie);
    const sequence: string[] = [];
    mock.method(
      getAxios(radarr),
      'put',
      async (_url: string, body: RadarrMovie) => {
        sequence.push('profile');
        assert.equal(body.qualityProfileId, 7);
        return { data: body };
      }
    );
    mock.method(radarr, 'searchMovie', async () => {
      sequence.push('search');
    });
    await radarr.addMovie(options);
    assert.deepEqual(sequence, ['profile', 'search']);
  });
  it('does not search after a profile update fails', async () => {
    const radarr = buildRadarr();
    mock.method(
      radarr,
      'getMovieByTmdbId',
      async () =>
        ({
          id: 9,
          tags: [],
          monitored: true,
          qualityProfileId: 1,
        }) as unknown as RadarrMovie
    );
    mock.method(getAxios(radarr), 'put', async () => {
      throw new Error('update failed');
    });
    const search = mock.method(radarr, 'searchMovie', async () => undefined);
    await assert.rejects(() => radarr.addMovie(options));
    assert.equal(search.mock.callCount(), 0);
  });
  it('updates protection on an available file without launching another download', async () => {
    const radarr = buildRadarr();
    mock.method(
      radarr,
      'getMovieByTmdbId',
      async () =>
        ({
          id: 9,
          tags: [],
          monitored: true,
          hasFile: true,
          qualityProfileId: 1,
        }) as unknown as RadarrMovie
    );
    const put = mock.method(
      getAxios(radarr),
      'put',
      async (_url: string, body: RadarrMovie) => ({
        data: body,
      })
    );
    const search = mock.method(radarr, 'searchMovie', async () => undefined);
    await radarr.addMovie(options);
    assert.equal(put.mock.callCount(), 1);
    assert.equal(search.mock.callCount(), 0);
  });
});
