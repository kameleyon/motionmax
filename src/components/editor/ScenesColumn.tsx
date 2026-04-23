import { Plus, Loader2 } from 'lucide-react';
import type { EditorScene, EditorState } from '@/hooks/useEditorState';
import { useActiveJobs } from './useActiveJobs';

/** Scene list column. Renders one row per scene with status badge,
 *  thumbnail (project aspect), title, and duration. Clicking a row
 *  selects that scene for the Stage + Inspector. */

const STATUS_LABEL: Record<EditorScene['status'], string> = {
  done: 'DONE',
  render: 'RENDER',
  image: 'IMAGE',
  audio: 'AUDIO',
  queue: 'QUEUE',
  fail: 'FAIL',
};

const STATUS_CLASS: Record<EditorScene['status'], string> = {
  done:   'text-[#14C8CC] bg-[#14C8CC]/14',
  render: 'text-[#14C8CC] bg-[#14C8CC]/14',
  image:  'text-[#14C8CC] bg-[#14C8CC]/14',
  audio:  'text-[#14C8CC] bg-[#14C8CC]/14',
  queue:  'text-[#8A9198] bg-[#1B2228]',
  fail:   'text-[#E4C875] bg-[#E4C875]/10',
};

function formatSceneDuration(scene: EditorScene): string {
  const ms = scene.audioDurationMs ?? scene.estDurationMs ?? 10_000;
  const s = Math.round(ms / 1000);
  return `0:${s.toString().padStart(2, '0')}`;
}

export default function ScenesColumn({
  state,
  selectedSceneIndex,
  onSelect,
}: {
  state: EditorState;
  selectedSceneIndex: number;
  onSelect: (index: number) => void;
}) {
  const { tasksForScene } = useActiveJobs(state.project?.id ?? null);

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-[2] flex items-center justify-between px-3 py-3 border-b border-white/5 bg-[#10151A]">
        <h3 className="font-serif font-medium text-[14px] text-[#ECEAE4] m-0">
          Scenes · <span className="text-[#8A9198]">{state.scenes.length}</span>
        </h3>
        <button
          type="button"
          title="Add scene"
          aria-label="Add scene"
          disabled
          className="w-7 h-7 grid place-items-center rounded-md text-[#5A6268] border border-white/5 bg-[#1B2228] opacity-50 cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
        {state.scenes.length === 0 ? (
          <div className="p-4 text-[12px] text-[#5A6268] italic">
            {state.phase === 'rendering'
              ? 'Scenes will appear here as the script phase completes…'
              : 'No scenes yet.'}
          </div>
        ) : (
          state.scenes.map((scene, i) => {
            const isActive = i === selectedSceneIndex;
            const active = tasksForScene(i);
            const imageRegen = active.has('regenerate_image') || active.has('cinematic_image');
            const videoRegen = active.has('cinematic_video');
            const audioRegen = active.has('regenerate_audio') || active.has('cinematic_audio');
            const anyActive = imageRegen || videoRegen || audioRegen;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(i)}
                className={
                  'w-full grid grid-cols-[24px_44px_1fr] gap-2 items-center px-2.5 py-2 border-b border-white/5 text-left transition-colors relative ' +
                  (isActive
                    ? 'bg-[#151B20]'
                    : 'hover:bg-[#151B20]/60')
                }
              >
                {isActive && (
                  <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-[#14C8CC] rounded-full" />
                )}
                <span className="font-mono text-[9.5px] text-[#5A6268] tracking-[0.06em] text-center">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div
                  className={
                    'rounded-[4px] border relative overflow-hidden ' +
                    (anyActive ? 'border-[#14C8CC] shadow-[0_0_0_1px_#14C8CC_inset]' : 'border-white/5')
                  }
                  style={{
                    aspectRatio: state.aspect === '9:16' ? '9/16' : '16/9',
                    background: scene.imageUrl
                      ? `center / cover no-repeat url("${scene.imageUrl}")`
                      : `linear-gradient(135deg, hsl(${(i * 40 + 180) % 360} 40% 28%), hsl(${(i * 40 + 200) % 360} 50% 12%))`,
                  }}
                >
                  {(scene.status === 'render' || anyActive) && (
                    <div className="absolute inset-0 grid place-items-center bg-black/55">
                      <Loader2 className="w-4 h-4 animate-spin text-[#14C8CC]" />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="font-serif text-[12.5px] text-[#ECEAE4] truncate leading-tight">
                    {scene.title || scene.visualPrompt?.slice(0, 40) || `Scene ${i + 1}`}
                  </div>
                  <div className="font-mono text-[9.5px] text-[#5A6268] tracking-[0.06em] mt-1 flex items-center gap-1.5 flex-wrap">
                    <span>{formatSceneDuration(scene)}</span>
                    <span className="text-white/20">·</span>
                    <span className={`px-1 py-[1px] rounded ${STATUS_CLASS[scene.status]}`}>
                      {STATUS_LABEL[scene.status]}
                    </span>
                    {imageRegen && (
                      <span className="px-1 py-[1px] rounded text-[#14C8CC] bg-[#14C8CC]/14 inline-flex items-center gap-1">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />IMAGE
                      </span>
                    )}
                    {videoRegen && (
                      <span className="px-1 py-[1px] rounded text-[#14C8CC] bg-[#14C8CC]/14 inline-flex items-center gap-1">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />VIDEO
                      </span>
                    )}
                    {audioRegen && (
                      <span className="px-1 py-[1px] rounded text-[#14C8CC] bg-[#14C8CC]/14 inline-flex items-center gap-1">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />VOICE
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
