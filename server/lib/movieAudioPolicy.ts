import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import type { RadarrSettings } from '@server/lib/settings';

export type MovieAudioPreference = 'automatic' | 'pt-PT' | 'original';
export interface MovieAudioPolicy {
  enabled: boolean;
  kidsMode: 'family' | 'all';
  ageCutoff: number;
  missingRatingFallback?: 'review' | 'jev';
  profiles: {
    radarrServiceId: number;
    kidsProfileId: number;
    originalProfileId: number;
  }[];
  exceptions: {
    tmdbId: number;
    preference: 'pt-PT' | 'original';
    note: string;
  }[];
}

export const defaultMovieAudioPolicy: MovieAudioPolicy = {
  enabled: false,
  kidsMode: 'family',
  ageCutoff: 12,
  missingRatingFallback: 'review',
  profiles: [],
  exceptions: [],
};

export interface MovieAudioDecision {
  enabled: boolean;
  preference: 'pt-PT' | 'original' | 'review';
  reason: string;
  age?: number;
  profileId?: number;
  serverId?: number;
  storedPreference?: MovieAudioPreference;
  audience?: {
    source: 'jev';
    model: string;
    choice: 'kids' | 'older' | 'uncertain';
    confidence: number;
    probabilities: Record<'kids' | 'older' | 'uncertain', number>;
  };
}

export class MovieAudioReviewError extends Error {}

/** Decide before any Radarr add, update, or search. Never equate PT with PT-PT. */
export function decideMovieAudio(
  movie: Pick<TmdbMovieDetails, 'id' | 'genres' | 'release_dates'>,
  policy: MovieAudioPolicy,
  servers: RadarrSettings[],
  {
    serverId,
    is4k = false,
    preference = 'automatic',
  }: {
    serverId?: number | null;
    is4k?: boolean;
    preference?: MovieAudioPreference;
  } = {}
): MovieAudioDecision {
  if (!policy.enabled) {
    return {
      enabled: false,
      preference: 'original',
      reason: 'Audio policy disabled',
    };
  }
  const server =
    serverId != null
      ? servers.find((s) => s.id === serverId)
      : servers.find((s) => s.isDefault && s.is4k === is4k);
  const profiles = policy.profiles.find(
    (p) => p.radarrServiceId === server?.id
  );
  const base = { enabled: true, serverId: server?.id };
  if (!server || !profiles) {
    return {
      ...base,
      preference: 'review',
      reason: 'Audio profiles are not configured for this Radarr server',
    };
  }

  const selected = (
    choice: 'pt-PT' | 'original',
    reason: string,
    age?: number
  ): MovieAudioDecision => ({
    ...base,
    preference: choice,
    reason,
    age,
    profileId:
      choice === 'pt-PT' ? profiles.kidsProfileId : profiles.originalProfileId,
  });
  if (preference !== 'automatic') {
    return selected(preference, 'Audio selected for this request');
  }
  const exception = policy.exceptions.find((e) => e.tmdbId === movie.id);
  if (exception) {
    return selected(
      exception.preference,
      exception.note || 'Saved movie exception'
    );
  }

  const ages = (movie.release_dates?.results ?? [])
    .filter((r) => r.iso_3166_1 === 'PT')
    .flatMap((r) => r.release_dates)
    .map((r) => r.certification.trim().match(/^(?:M\s*\/\s*)?(\d{1,2})\+?$/i))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => Number(match[1]));
  // Use the highest regional age where editions have different certifications.
  const age = ages.length ? Math.max(...ages) : undefined;
  if (age !== undefined && age >= policy.ageCutoff) {
    return selected('original', `Portugal rating ${age}+`, age);
  }
  const isFamily = movie.genres?.some((g) => [16, 10751].includes(g.id));
  if (policy.kidsMode === 'family' && !isFamily) {
    return selected(
      'original',
      'Outside the family and animation categories',
      age
    );
  }
  if (age === undefined) {
    return {
      ...base,
      preference: 'review',
      reason: 'Portugal age rating missing; choose audio before approval',
    };
  }
  return selected(
    'pt-PT',
    `Portugal rating ${age}+ below ${policy.ageCutoff}`,
    age
  );
}
