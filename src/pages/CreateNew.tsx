import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import type { ProjectMode } from '@/components/intake/types';
import IntakeFrame from '@/components/intake/IntakeFrame';
import IntakeForm from '@/components/intake/IntakeForm';

const MODE_TITLE: Record<ProjectMode, string> = {
  cinematic: 'Cinematic',
  doc2video: 'Explainer',
  smartflow: 'Smart Flow',
};

/** URL-shaped modes → canonical ProjectMode. Anything we don't recognise
 *  falls back to cinematic so the page never renders a blank state when a
 *  user hand-edits the query string. */
function modeFromParam(raw: string | null): ProjectMode {
  switch ((raw ?? '').toLowerCase()) {
    case 'doc2video': return 'doc2video';
    case 'smartflow': return 'smartflow';
    case 'cinematic':
    default:          return 'cinematic';
  }
}

export default function CreateNew() {
  const [params] = useSearchParams();
  const mode = modeFromParam(params.get('mode'));

  return (
    <>
      <Helmet>
        <title>Create {MODE_TITLE[mode]} · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <IntakeFrame mode={mode}>
        <IntakeForm
          mode={mode}
          initialPrompt={params.get('prompt') ?? ''}
          initialLanguage={params.get('lang') ?? 'en'}
          initialFormat={params.get('format') ?? 'portrait'}
          initialVoice={params.get('voice') ?? ''}
        />
      </IntakeFrame>
    </>
  );
}
