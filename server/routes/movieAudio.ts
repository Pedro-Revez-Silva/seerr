import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
import { resolveMovieAudio } from '@server/lib/movieAudience';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { z } from 'zod';

const routes = Router();
const policySchema = z.object({
  enabled: z.boolean(),
  kidsMode: z.enum(['family', 'all']),
  ageCutoff: z.number().int().min(1).max(21),
  missingRatingFallback: z.enum(['review', 'jev']).default('review'),
  profiles: z
    .array(
      z.object({
        radarrServiceId: z.number().int().min(0),
        kidsProfileId: z.number().int().positive(),
        originalProfileId: z.number().int().positive(),
      })
    )
    .max(20),
  exceptions: z
    .array(
      z.object({
        tmdbId: z.number().int().positive(),
        preference: z.enum(['pt-PT', 'original']),
        note: z.string().max(500),
      })
    )
    .max(1000),
});

routes.get('/', isAuthenticated(Permission.ADMIN), (_req, res) => {
  res.json(getSettings().movieAudio);
});
routes.get(
  '/audienceProvider',
  isAuthenticated(Permission.ADMIN),
  (_req, res) => {
    res.json({ configured: !!process.env.TYPESAFE_API_KEY });
  }
);
routes.post('/', isAuthenticated(Permission.ADMIN), async (req, res, next) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success)
    return next({ status: 400, message: 'Invalid movie audio settings.' });
  const policy = parsed.data;
  if (policy.missingRatingFallback === 'jev' && !process.env.TYPESAFE_API_KEY) {
    return next({
      status: 400,
      message:
        'Configure the server\u2019s TypeSafe API key before enabling audience assessment.',
    });
  }
  if (
    new Set(policy.profiles.map((p) => p.radarrServiceId)).size !==
      policy.profiles.length ||
    new Set(policy.exceptions.map((e) => e.tmdbId)).size !==
      policy.exceptions.length
  ) {
    return next({
      status: 400,
      message: 'Duplicate servers or movie exceptions.',
    });
  }
  const settings = getSettings();
  try {
    if (policy.enabled) {
      for (const mapping of policy.profiles) {
        const server = settings.radarr.find(
          (s) => s.id === mapping.radarrServiceId
        );
        if (!server || mapping.kidsProfileId === mapping.originalProfileId) {
          return next({
            status: 400,
            message:
              'Select distinct audio profiles for a configured Radarr server.',
          });
        }
        const api = new RadarrAPI({
          url: RadarrAPI.buildUrl(server, '/api/v3'),
          apiKey: server.apiKey,
        });
        const profiles = await api.getProfiles();
        if (
          ![mapping.kidsProfileId, mapping.originalProfileId].every((id) =>
            profiles.some((p) => p.id === id)
          )
        ) {
          return next({
            status: 400,
            message: 'An audio profile does not exist in Radarr.',
          });
        }
      }
      if (
        settings.radarr.some(
          (s) =>
            s.isDefault &&
            !policy.profiles.some((p) => p.radarrServiceId === s.id)
        )
      ) {
        return next({
          status: 400,
          message: 'Configure audio profiles for every default Radarr server.',
        });
      }
    }
    settings.movieAudio = policy;
    await settings.save();
    return res.json(policy);
  } catch {
    return next({
      status: 503,
      message: 'Unable to verify or save audio profiles.',
    });
  }
});

routes.get('/:tmdbId', async (req, res, next) => {
  const id = Number(req.params.tmdbId);
  const serverId =
    req.query.serverId === undefined ? undefined : Number(req.query.serverId);
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    (serverId !== undefined &&
      (!Number.isSafeInteger(serverId) || serverId < 0))
  ) {
    return next({ status: 400, message: 'Invalid movie or server ID.' });
  }
  try {
    const settings = getSettings();
    const movie = await new TheMovieDb().getMovie({ movieId: id });
    const decision = await resolveMovieAudio(
      movie,
      settings.movieAudio,
      settings.radarr,
      {
        serverId,
        is4k: String(req.query.is4k) === 'true',
      }
    );
    const mapping = settings.movieAudio.profiles.find(
      (p) => p.radarrServiceId === decision.serverId
    );
    if (mapping && req.query.profileId !== undefined) {
      const profileId = Number(req.query.profileId);
      decision.storedPreference =
        profileId === mapping.kidsProfileId
          ? 'pt-PT'
          : profileId === mapping.originalProfileId
            ? 'original'
            : 'automatic';
    }
    return res.json(decision);
  } catch {
    return next({ status: 503, message: 'Unable to determine movie audio.' });
  }
});
export default routes;
