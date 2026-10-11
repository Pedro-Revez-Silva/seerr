import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { ServiceCommonServerWithDetails } from '@server/interfaces/api/serviceInterfaces';
import type { MovieAudioPolicy } from '@server/lib/movieAudioPolicy';
import { defaultMovieAudioPolicy } from '@server/lib/movieAudioPolicy';
import type { RadarrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.MovieAudio', {
  title: 'Movie Audio',
  description:
    'Select European Portuguese for children’s films and original audio for older audiences before a download starts. Use saved movie exceptions or optional audience assessment when Portugal ratings are missing.',
  enabled: 'Enable Automatic Audio Routing',
  mode: 'Children’s Movies',
  family: 'Family and animation below the age cutoff',
  all: 'Every movie below the age cutoff',
  cutoff: 'Original Audio From Age',
  missing: 'Missing Portugal Ratings',
  review: 'Ask for an audio choice',
  jev: 'Assess the intended audience automatically',
  audienceHelp:
    'Automatic assessment uses the synopsis and available ratings. Uncertain results still ask for an audio choice. Explicit choices, saved exceptions, and Portugal ratings take priority.',
  providerMissing:
    'Automatic assessment is available after the TypeSafe provider is configured on the server.',
  kidsProfile: 'PT-PT Profile',
  originalProfile: 'Original Audio Profile',
  selectProfile: 'Select a profile',
  profilesHelp:
    'Choose dedicated Radarr profiles. The PT-PT profile must require explicit Portugal audio evidence and prevent automatic upgrades.',
  exceptions: 'Movie Exceptions',
  movieId: 'TMDB Movie ID',
  preference: 'Audio',
  ptpt: 'Portuguese (Portugal)',
  original: 'Original Language',
  note: 'Reason',
  add: 'Add Exception',
  remove: 'Remove',
  save: 'Save Audio Settings',
  saved: 'Movie audio settings saved.',
  error: 'Unable to save movie audio settings.',
});

const AudioProfiles = ({
  mapping,
  name,
  onChange,
}: {
  mapping: MovieAudioPolicy['profiles'][number];
  name: string;
  onChange: (key: 'kidsProfileId' | 'originalProfileId', id: number) => void;
}) => {
  const intl = useIntl();
  const { data } = useSWR<ServiceCommonServerWithDetails>(
    `/api/v1/service/radarr/${mapping.radarrServiceId}`
  );
  return (
    <div className="my-4 space-y-2">
      <h4>{name}</h4>
      {(['kidsProfileId', 'originalProfileId'] as const).map((key) => (
        <div className="form-row" key={key}>
          <label
            className="text-label"
            htmlFor={`${mapping.radarrServiceId}-${key}`}
          >
            {intl.formatMessage(
              key === 'kidsProfileId'
                ? messages.kidsProfile
                : messages.originalProfile
            )}
          </label>
          <select
            id={`${mapping.radarrServiceId}-${key}`}
            value={mapping[key]}
            disabled={!data}
            onChange={(e) => onChange(key, Number(e.target.value))}
          >
            <option value={0}>
              {intl.formatMessage(messages.selectProfile)}
            </option>
            {(data?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
};

const SettingsMovieAudio = ({ servers }: { servers: RadarrSettings[] }) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<MovieAudioPolicy>('/api/v1/movieAudio');
  const { data: provider } = useSWR<{ configured: boolean }>(
    '/api/v1/movieAudio/audienceProvider'
  );
  if (!data) return null;
  const initialValues = {
    ...defaultMovieAudioPolicy,
    ...data,
    profiles: servers.map(
      (s) =>
        data.profiles.find((p) => p.radarrServiceId === s.id) ?? {
          radarrServiceId: s.id,
          kidsProfileId: 0,
          originalProfileId: 0,
        }
    ),
  };
  return (
    <div className="mb-8 mt-6">
      <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
      <p className="description">{intl.formatMessage(messages.description)}</p>
      <Formik
        initialValues={initialValues}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            const response = await axios.post('/api/v1/movieAudio', {
              ...values,
              profiles: values.profiles.filter(
                (p) => p.kidsProfileId > 0 && p.originalProfileId > 0
              ),
            });
            await mutate(response.data, false);
            addToast(intl.formatMessage(messages.saved), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch (error) {
            addToast(
              axios.isAxiosError(error)
                ? (error.response?.data?.message ??
                    intl.formatMessage(messages.error))
                : intl.formatMessage(messages.error),
              { appearance: 'error', autoDismiss: true }
            );
          }
        }}
      >
        {({ values, handleChange, setFieldValue, isSubmitting }) => (
          <Form className="section">
            <div className="form-row">
              <label htmlFor="movieAudioEnabled" className="text-label">
                {intl.formatMessage(messages.enabled)}
              </label>
              <input
                id="movieAudioEnabled"
                type="checkbox"
                checked={values.enabled}
                onChange={(e) => setFieldValue('enabled', e.target.checked)}
              />
            </div>
            <div className="form-row">
              <label htmlFor="kidsMode" className="text-label">
                {intl.formatMessage(messages.mode)}
              </label>
              <select
                id="kidsMode"
                name="kidsMode"
                value={values.kidsMode}
                onChange={handleChange}
              >
                <option value="family">
                  {intl.formatMessage(messages.family)}
                </option>
                <option value="all">{intl.formatMessage(messages.all)}</option>
              </select>
            </div>
            <div className="form-row">
              <label htmlFor="ageCutoff" className="text-label">
                {intl.formatMessage(messages.cutoff)}
              </label>
              <input
                id="ageCutoff"
                name="ageCutoff"
                type="number"
                min={1}
                max={21}
                value={values.ageCutoff}
                onChange={handleChange}
              />
            </div>
            <p className="label-tip">
              {intl.formatMessage(messages.profilesHelp)}
            </p>
            <div className="form-row">
              <label htmlFor="missingRatingFallback" className="text-label">
                {intl.formatMessage(messages.missing)}
              </label>
              <select
                id="missingRatingFallback"
                name="missingRatingFallback"
                value={values.missingRatingFallback}
                onChange={handleChange}
              >
                <option value="review">
                  {intl.formatMessage(messages.review)}
                </option>
                <option value="jev" disabled={!provider?.configured}>
                  {intl.formatMessage(messages.jev)}
                </option>
              </select>
            </div>
            <p className="label-tip">
              {intl.formatMessage(messages.audienceHelp)}{' '}
              {!provider?.configured &&
                intl.formatMessage(messages.providerMissing)}
            </p>
            {values.profiles.map((mapping, index) => (
              <AudioProfiles
                key={mapping.radarrServiceId}
                mapping={mapping}
                name={
                  servers.find((s) => s.id === mapping.radarrServiceId)?.name ??
                  ''
                }
                onChange={(key, id) =>
                  setFieldValue(`profiles.${index}.${key}`, id)
                }
              />
            ))}
            <h4 className="my-4">{intl.formatMessage(messages.exceptions)}</h4>
            {values.exceptions.map((exception, index) => (
              <div key={index} className="mb-4 grid gap-2 sm:grid-cols-4">
                <label>
                  {intl.formatMessage(messages.movieId)}
                  <input
                    name={`exceptions.${index}.tmdbId`}
                    type="number"
                    min={1}
                    value={exception.tmdbId}
                    onChange={handleChange}
                  />
                </label>
                <label>
                  {intl.formatMessage(messages.preference)}
                  <select
                    name={`exceptions.${index}.preference`}
                    value={exception.preference}
                    onChange={handleChange}
                  >
                    <option value="pt-PT">
                      {intl.formatMessage(messages.ptpt)}
                    </option>
                    <option value="original">
                      {intl.formatMessage(messages.original)}
                    </option>
                  </select>
                </label>
                <label>
                  {intl.formatMessage(messages.note)}
                  <input
                    name={`exceptions.${index}.note`}
                    value={exception.note}
                    maxLength={500}
                    onChange={handleChange}
                  />
                </label>
                <Button
                  type="button"
                  onClick={() =>
                    setFieldValue(
                      'exceptions',
                      values.exceptions.filter((_, i) => i !== index)
                    )
                  }
                >
                  {intl.formatMessage(messages.remove)}
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() =>
                  setFieldValue('exceptions', [
                    ...values.exceptions,
                    { tmdbId: 0, preference: 'pt-PT', note: '' },
                  ])
                }
              >
                {intl.formatMessage(messages.add)}
              </Button>
              <Button
                type="submit"
                buttonType="primary"
                disabled={isSubmitting}
              >
                {intl.formatMessage(messages.save)}
              </Button>
            </div>
          </Form>
        )}
      </Formik>
    </div>
  );
};
export default SettingsMovieAudio;
