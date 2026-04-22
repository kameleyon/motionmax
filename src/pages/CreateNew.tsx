import { useSearchParams } from 'react-router-dom';
import type { ProjectMode } from '@/components/intake/types';
import IntakeFrame from '@/components/intake/IntakeFrame';
import IntakeForm from '@/components/intake/IntakeForm';

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
    <IntakeFrame mode={mode}>
      <IntakeForm
        mode={mode}
        initialPrompt={params.get('prompt') ?? ''}
        initialLanguage={params.get('lang') ?? 'en'}
        initialFormat={params.get('format') ?? 'landscape'}
        initialVoice={params.get('voice') ?? ''}
      />
    </IntakeFrame>
  );
}
