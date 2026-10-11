import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import type {
  MovieAudioDecision,
  MovieAudioPreference,
} from '@server/lib/movieAudioPolicy';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.MovieAudio', {
  audio: 'Movie Audio',
  automatic: 'Automatic',
  ptpt: 'Portuguese (Portugal)',
  original: 'Original Language',
  review: 'Audio Needs Review',
  ptptDecision: 'Portuguese (Portugal) audio required',
  originalDecision: 'Original audio language required',
});

export default function MovieAudioChoice({
  decision,
  preference,
  onChange,
  canOverride,
}: {
  decision?: MovieAudioDecision;
  preference: MovieAudioPreference;
  onChange: (value: MovieAudioPreference) => void;
  canOverride: boolean;
}) {
  const intl = useIntl();
  if (!decision?.enabled) return null;
  const selected =
    preference === 'automatic' ? decision.preference : preference;
  return (
    <div className="my-4 space-y-3">
      <Alert
        type={selected === 'review' ? 'warning' : 'info'}
        title={intl.formatMessage(
          selected === 'review'
            ? messages.review
            : selected === 'pt-PT'
              ? messages.ptptDecision
              : messages.originalDecision
        )}
      >
        {preference === 'automatic' && decision.reason}
      </Alert>
      {canOverride && (
        <div className="form-row">
          <label className="text-label" htmlFor="movie-audio-choice">
            {intl.formatMessage(messages.audio)}
          </label>
          <select
            id="movie-audio-choice"
            value={preference}
            onChange={(e) => onChange(e.target.value as MovieAudioPreference)}
          >
            <option value="automatic">
              {intl.formatMessage(messages.automatic)}
            </option>
            <option value="pt-PT">{intl.formatMessage(messages.ptpt)}</option>
            <option value="original">
              {intl.formatMessage(messages.original)}
            </option>
          </select>
        </div>
      )}
    </div>
  );
}
