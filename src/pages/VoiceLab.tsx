import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Mic, 
  Upload, 
  Play, 
  Square, 
  Trash2, 
  Loader2, 
  Check,
  Volume2,
  AudioWaveform,
  VolumeX,
  ThumbsUp,
  Headphones,
  Pause,
  AlertCircle
} from "lucide-react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useVoiceCloning, UserVoice } from "@/hooks/useVoiceCloning";
import { toast } from "sonner";
import { useSubscription } from "@/hooks/useSubscription";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useSidebarState } from "@/hooks/useSidebarState";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function VoiceLab() {
  const navigate = useNavigate();
  const { isOpen: sidebarOpen, setIsOpen: setSidebarOpen } = useSidebarState();
  const { voices, voicesLoading, isCloning, cloneVoice, deleteVoice } = useVoiceCloning();
  
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  
  // Upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [removeNoise, setRemoveNoise] = useState(true);
  
  // Form state
  const [voiceName, setVoiceName] = useState("");
  
  const [consentAccepted, setConsentAccepted] = useState(false);

  // Visualizer state
  const [audioLevels, setAudioLevels] = useState<number[]>(new Array(20).fill(0));
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Audio preview
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);

  // Modal state for existing voice warning
  const [showExistingVoiceModal, setShowExistingVoiceModal] = useState(false);

  // Helper to get audio duration from a blob
  const getAudioDuration = (blob: Blob): Promise<number> => {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.addEventListener("loadedmetadata", () => {
        if (isFinite(audio.duration)) {
          resolve(audio.duration);
        } else {
          reject(new Error("Duration not available"));
        }
        URL.revokeObjectURL(audio.src);
      });
      audio.addEventListener("error", () => {
        URL.revokeObjectURL(audio.src);
        reject(new Error("Failed to load audio"));
      });
      audio.src = URL.createObjectURL(blob);
    });
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);


  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Set up audio analyzer for visualization
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 64;
      source.connect(analyzer);
      analyzerRef.current = analyzer;

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setRecordedBlob(blob);
        stream.getTracks().forEach(track => track.stop());
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
      };

      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingDuration(0);

      // Start timer
      timerRef.current = window.setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

      // Start visualizer
      const updateLevels = () => {
        if (analyzerRef.current) {
          const dataArray = new Uint8Array(analyzerRef.current.frequencyBinCount);
          analyzerRef.current.getByteFrequencyData(dataArray);
          const levels = Array.from(dataArray.slice(0, 20)).map(v => v / 255);
          setAudioLevels(levels);
        }
        animationFrameRef.current = requestAnimationFrame(updateLevels);
      };
      updateLevels();

    } catch (error) {
      console.error("Failed to start recording:", error);
      toast.error("Microphone access denied", {
        description: "Please allow microphone access in your browser settings to record audio.",
      });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setAudioLevels(new Array(20).fill(0));
    }
  };

  const handleFileUpload = async (file: File) => {
    const validAudioTypes = [
      "audio/mpeg", "audio/wav", "audio/mp3", "audio/m4a", "audio/x-m4a",
      "video/mp4", "audio/mp4" // MP4 can contain audio
    ];
    const validExtensions = ['.mp3', '.wav', '.m4a', '.mp4'];
    const hasValidType = validAudioTypes.includes(file.type);
    const hasValidExtension = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
    
    if (!(file && (hasValidType || hasValidExtension))) {
      toast.error("Invalid file type", {
        description: "Please upload an MP3, WAV, M4A, or MP4 file.",
      });
      return;
    }

    // Validate minimum duration (10 seconds) for uploaded files
    try {
      const duration = await getAudioDuration(file);
      if (duration < 10) {
        toast.error("Audio too short", {
          description: "Uploaded audio must be at least 10 seconds long for voice cloning.",
        });
        return;
      }
    } catch {
      // If we can't determine duration client-side, allow and let backend validate
      console.warn("[VoiceLab] Could not validate upload duration client-side, proceeding");
    }

    setUploadedFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileUpload(file);
  };

  const handleClone = async () => {
    const audioBlob = recordedBlob || uploadedFile;
    if (!audioBlob || !voiceName.trim()) return;

    // Validate minimum audio duration (10 seconds)
    try {
      const audioDuration = await getAudioDuration(audioBlob);
      if (audioDuration < 10) {
        toast.error("Audio too short", {
          description: "Audio must be at least 10 seconds long for voice cloning.",
        });
        return;
      }
    } catch {
      // If we can't determine duration, proceed anyway
      console.warn("[VoiceLab] Could not determine audio duration, proceeding");
    }

    await cloneVoice({ 
      file: audioBlob, 
      name: voiceName.trim(),
      description: `Created via ${recordedBlob ? "recording" : "file upload"}`,
      removeNoise,
    });

    // Reset form
    setVoiceName("");
    setRecordedBlob(null);
    setUploadedFile(null);
    setRecordingDuration(0);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const playPreview = (url: string, voiceId: string) => {
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      if (playingVoiceId === voiceId) {
        setIsPlaying(false);
        setPlayingVoiceId(null);
        return;
      }
    }
    const audio = new Audio(url);
    audioPreviewRef.current = audio;
    audio.onended = () => {
      setIsPlaying(false);
      setPlayingVoiceId(null);
    };
    audio.play();
    setIsPlaying(true);
    setPlayingVoiceId(voiceId);
  };

  const hasAudio = !!recordedBlob || !!uploadedFile;
  const { plan } = useSubscription();
  const voiceCloneLimit = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS]?.voiceClones ?? 0;
  const hasExistingVoice = voices.length >= voiceCloneLimit;
  const canClone = hasAudio && voiceName.trim().length > 0 && !isCloning && !hasExistingVoice && consentAccepted;
  const isReady = hasAudio;

  // Show modal when user has existing voice and tries to add audio
  useEffect(() => {
    if (hasAudio && voices.length >= voiceCloneLimit && voiceCloneLimit > 0) {
      setShowExistingVoiceModal(true);
    }
  }, [hasAudio, voices.length, voiceCloneLimit]);

  // Scroll to My Voices section when modal action is taken
  const scrollToMyVoices = () => {
    const myVoicesSection = document.getElementById("my-voices-section");
    if (myVoicesSection) {
      myVoicesSection.scrollIntoView({ behavior: "smooth" });
    }
    setShowExistingVoiceModal(false);
  };

  return (
    <SidebarProvider defaultOpen={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        
        
        <main className="flex-1 flex flex-col">
          {/* Header */}
          <header className="sticky top-0 z-40 grid h-14 sm:h-16 grid-cols-3 items-center border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
            <div className="flex items-center justify-start gap-2">
              <SidebarTrigger />
              <ThemedLogo className="hidden lg:block h-10 w-auto" />
            </div>
            <div className="flex justify-center lg:hidden">
              <ThemedLogo className="h-10 w-auto" />
            </div>
            <div className="flex items-center justify-end">
              <ThemeToggle />
            </div>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
            <div className="max-w-4xl mx-auto space-y-8">
              {/* Hero */}
              <div className="text-center space-y-3">
                <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <Mic className="h-3.5 w-3.5" />
                  Voice Lab
                </span>
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                  Clone Your Voice
                </h1>
                <p className="text-sm text-muted-foreground/70">
                  Create your digital twin with AI voice cloning
                </p>
              </div>

              {/* Tips Section */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
                <div className="flex flex-col items-start gap-2">
                  <VolumeX className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-medium text-sm">Avoid noisy environments</h3>
                  <p className="text-xs text-muted-foreground">Background sounds interfere with recording quality results.</p>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <ThumbsUp className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-medium text-sm">Check microphone quality</h3>
                  <p className="text-xs text-muted-foreground">Try external units or headphone mics for better audio capture.</p>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <Headphones className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-medium text-sm">Use consistent equipment</h3>
                  <p className="text-xs text-muted-foreground">Don't change recording equipment between samples.</p>
                </div>
              </div>

              {/* Main Upload/Record Area */}
              <div className="space-y-6">
                {/* Upload Zone */}
                <div
                  className={cn(
                    "border-2 border-dashed rounded-2xl p-8 md:p-12 text-center transition-all cursor-pointer",
                    isDragging ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50",
                  )}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".mp3,.wav,.m4a,.mp4,audio/mpeg,audio/wav,audio/m4a,audio/x-m4a,video/mp4,audio/mp4"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
                  />
                  
                  <div className="space-y-4">
                    <div className="mx-auto w-12 h-12 flex items-center justify-center">
                      <Upload className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">Click to upload, or drag and drop</p>
                      <p className="text-sm text-muted-foreground">MP3, WAV, M4A, or MP4 files up to 10MB</p>
                    </div>
                    
                    <div className="flex items-center justify-center">
                      <Badge variant="secondary" className="bg-muted text-muted-foreground">or</Badge>
                    </div>
                    
                    {/* Record Button - inside zone but with stopPropagation */}
                    <Button
                      variant="outline"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        isRecording ? stopRecording() : startRecording();
                      }}
                      className={cn(
                        "gap-2",
                        isRecording && "border-primary text-primary"
                      )}
                    >
                      {isRecording ? (
                        <>
                          <Square className="h-4 w-4" />
                          Stop Recording ({formatDuration(recordingDuration)})
                        </>
                      ) : (
                        <>
                          <Mic className="h-4 w-4" />
                          Record audio
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Recording Visualizer (shows when recording) */}
                {isRecording && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="h-16 bg-muted/30 rounded-xl flex items-center justify-center gap-1 px-4"
                  >
                    {audioLevels.map((level, i) => (
                      <motion.div
                        key={i}
                        className="w-1.5 bg-primary rounded-full"
                        animate={{ 
                          height: Math.max(4, level * 48) 
                        }}
                        transition={{ duration: 0.05 }}
                      />
                    ))}
                  </motion.div>
                )}

                {/* Uploaded/Recorded Files List */}
                <AnimatePresence>
                  {(uploadedFile || recordedBlob) && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="space-y-4"
                    >
                      <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {uploadedFile ? uploadedFile.name : "Recording.webm"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {uploadedFile 
                              ? `${(uploadedFile.size / 1024 / 1024).toFixed(2)} MB`
                              : formatDuration(recordingDuration)
                            }
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => {
                              // Preview functionality for uploaded file
                              if (uploadedFile) {
                                const url = URL.createObjectURL(uploadedFile);
                                playPreview(url, "preview");
                              } else if (recordedBlob) {
                                const url = URL.createObjectURL(recordedBlob);
                                playPreview(url, "preview");
                              }
                            }}
                          >
                            {playingVoiceId === "preview" ? (
                              <Pause className="h-4 w-4" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              setUploadedFile(null);
                              setRecordedBlob(null);
                              setRecordingDuration(0);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {/* Remove noise checkbox */}
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="remove-noise"
                          checked={removeNoise}
                          onCheckedChange={(checked) => setRemoveNoise(checked as boolean)}
                        />
                        <label htmlFor="remove-noise" className="text-sm font-medium cursor-pointer">
                          Remove background noise from audio
                        </label>
                      </div>

                      {/* Ready indicator */}
                      <div className="flex items-center gap-2 text-primary">
                        <Check className="h-4 w-4" />
                        <div>
                          <p className="text-sm font-medium">Ready</p>
                          <p className="text-xs text-muted-foreground">Continue to add recordings for a better clone</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 10 seconds required note */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="h-4 w-4 rounded-full border border-muted-foreground/50" />
                  <span>10 seconds of audio required</span>
                </div>

                {/* Voice name input and Clone button */}
                {isReady && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4 pt-4 border-t border-border"
                  >
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Voice Name</label>
                      <Input
                        placeholder="e.g., My Professional Voice"
                        value={voiceName}
                        onChange={(e) => setVoiceName(e.target.value)}
                        disabled={isCloning}
                        className="bg-muted/30"
                      />
                    </div>

                    {/* Consent Disclaimer */}
                    <div className="flex items-start gap-3 p-4 bg-muted/30 rounded-lg border border-border/50">
                      <Checkbox
                        id="voice-consent"
                        checked={consentAccepted}
                        onCheckedChange={(checked) => setConsentAccepted(checked === true)}
                        disabled={isCloning}
                        className="mt-0.5"
                      />
                      <label htmlFor="voice-consent" className="text-sm text-muted-foreground leading-relaxed cursor-pointer">
                        I hereby confirm that I have all necessary rights or consents to upload and clone these voice samples and that I will not use the platform-generated content for any illegal, fraudulent, or harmful purpose. I reaffirm my obligation to abide by MotionMax's{" "}
                        <a href="/terms" className="text-primary underline hover:no-underline">Terms of Service</a>,{" "}
                        <a href="/privacy" className="text-primary underline hover:no-underline">Privacy Policy</a>, and{" "}
                        <a href="/acceptable-use" className="text-primary underline hover:no-underline">Acceptable Use Policy</a>.
                      </label>
                    </div>

                    <div className="flex flex-col gap-2">
                      {hasExistingVoice && (
                        <p className="text-sm text-destructive">
                          You've reached your plan's limit of {voiceCloneLimit} cloned voice(s). Delete one to create a new one.
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button
                          size="lg"
                          disabled={!canClone}
                          onClick={handleClone}
                          className="px-8"
                        >
                          {isCloning ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Cloning...
                            </>
                          ) : (
                            "Next"
                          )}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>

              {/* My Voices Section */}
              {voices.length > 0 && (
                <Card id="my-voices-section" className="border-border/50">
                  <CardHeader>
                    <CardTitle className="text-lg">My Voices</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <AnimatePresence>
                        {voices.map((voice) => (
                          <VoiceCard
                            key={voice.id}
                            voice={voice}
                            isPlaying={playingVoiceId === voice.id}
                            onPlay={() => playPreview(voice.sample_url, voice.id)}
                            onDelete={() => deleteVoice(voice.id)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </CardContent>
                </Card>
              )}

              {voicesLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        </main>

        {/* Existing Voice Warning Modal */}
        <Dialog open={showExistingVoiceModal} onOpenChange={setShowExistingVoiceModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-primary" />
                Voice Limit Reached
              </DialogTitle>
              <DialogDescription className="pt-2">
                You have reached your plan's voice clone limit ({voiceCloneLimit}). Delete an existing voice to create a new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-3 pt-4">
              <Button 
                variant="outline" 
                onClick={() => setShowExistingVoiceModal(false)}
              >
                Cancel
              </Button>
              <Button onClick={scrollToMyVoices}>
                Go to My Voices
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </SidebarProvider>
  );
}

interface VoiceCardProps {
  voice: UserVoice;
  isPlaying: boolean;
  onPlay: () => void;
  onDelete: () => void;
}

function VoiceCard({ voice, isPlaying, onPlay, onDelete }: VoiceCardProps) {
  // Safely format the creation date
  const getCreatedTimeAgo = () => {
    try {
      if (!voice.created_at) return "recently";
      const date = new Date(voice.created_at);
      if (isNaN(date.getTime())) return "recently";
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return "recently";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="group flex items-center gap-3 p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
    >
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0 h-10 w-10 rounded-full bg-primary/10 hover:bg-primary/20"
        onClick={onPlay}
      >
        {isPlaying ? (
          <Pause className="h-4 w-4 text-primary" />
        ) : (
          <Play className="h-4 w-4 text-primary" />
        )}
      </Button>
      
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{voice.voice_name}</p>
        <p className="text-xs text-muted-foreground">
          Created {getCreatedTimeAgo()}
        </p>
      </div>

      <Badge variant="secondary" className="bg-primary/10 text-primary border-0">
        Active
      </Badge>

      <Button
        size="icon"
        variant="ghost"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </motion.div>
  );
}
