import { Camera, Palette } from 'lucide-react';
import { IntakeField, IntakeLabel, IntakeSlider, Pill } from '../primitives';
import type {
  CameraMotion,
  ColorGrade,
  SceneTransition,
} from '../types';

const CAMERA_MOTIONS: CameraMotion[] = ['Default', 'Static', 'Dolly', 'Handheld', 'Drone', 'Crane', 'Whip Pan'];
const SCENE_TRANSITIONS: SceneTransition[] = ['Default', 'Cut', 'Dissolve', 'Whip', 'Black'];
const COLOR_GRADES: ColorGrade[] = ['Kodak 250D', 'Bleach Bypass', 'Teal & Orange', 'Warm Film', 'Cool Noir', 'Desaturated'];

export interface DirectionBlockProps {
  tone: number;
  onToneChange: (v: number) => void;
  showCamera: boolean;
  camera: CameraMotion;
  onCameraChange: (c: CameraMotion) => void;
  showTransition: boolean;
  transition: SceneTransition;
  onTransitionChange: (t: SceneTransition) => void;
  showColorGrade: boolean;
  grade: ColorGrade;
  onGradeChange: (g: ColorGrade) => void;
}

/** C-5-7 (Prism PERF-011): extracted from IntakeForm.tsx so the
 *  CAMERA_MOTIONS / SCENE_TRANSITIONS / COLOR_GRADES constant tables
 *  + the four pill-row + slider blocks ship in their own React.lazy
 *  chunk. Loaded under <Suspense> from the parent so it doesn't block
 *  the prompt textarea on first paint. */
export default function DirectionBlock({
  tone,
  onToneChange,
  showCamera,
  camera,
  onCameraChange,
  showTransition,
  transition,
  onTransitionChange,
  showColorGrade,
  grade,
  onGradeChange,
}: DirectionBlockProps) {
  return (
    <div>
      <IntakeLabel>Direction</IntakeLabel>
      <div className="grid gap-3">
        <IntakeField>
          <div className="flex items-center gap-3 mb-2">
            <div className="text-[12.5px] font-medium text-[#ECEAE4]">Tone & pacing</div>
            <div className="font-mono text-[10px] text-[#5A6268] tracking-wider">
              {tone < 25 ? 'CALM' : tone < 55 ? 'MEASURED' : tone < 80 ? 'ENERGETIC' : 'FRENETIC'}
            </div>
          </div>
          <IntakeSlider value={tone} onChange={onToneChange} fmt={(v) => `${v}%`} />
        </IntakeField>

        {showCamera && (
          <IntakeField>
            <div className="text-[12.5px] font-medium text-[#ECEAE4] mb-2.5 flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" /> Camera movement
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CAMERA_MOTIONS.map((c) => (
                <Pill key={c} on={c === camera} onClick={() => onCameraChange(c)}>{c}</Pill>
              ))}
            </div>
          </IntakeField>
        )}

        {showTransition && (
          <IntakeField>
            <div className="text-[12.5px] font-medium text-[#ECEAE4] mb-2.5 flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" /> Transition
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCENE_TRANSITIONS.map((t) => (
                <Pill key={t} on={t === transition} onClick={() => onTransitionChange(t)}>{t}</Pill>
              ))}
            </div>
            <p className="text-[11px] text-[#5A6268] mt-2 leading-[1.45]">
              Applied to every scene boundary. "Default" uses the current fade-in/out behaviour.
            </p>
          </IntakeField>
        )}

        {showColorGrade && (
          <IntakeField>
            <div className="text-[12.5px] font-medium text-[#ECEAE4] mb-2.5 flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5" /> Color grade
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_GRADES.map((g) => (
                <Pill key={g} on={g === grade} onClick={() => onGradeChange(g)}>{g}</Pill>
              ))}
            </div>
          </IntakeField>
        )}
      </div>
    </div>
  );
}
