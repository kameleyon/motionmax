import { useState } from "react";
import { Loader2, Building2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface EnterpriseContactModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function EnterpriseContactModal({ open, onOpenChange }: EnterpriseContactModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Full name is required.";
    if (!email.trim()) newErrors.email = "Work email is required.";
    if (!company.trim()) newErrors.company = "Company name is required.";
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      toast.error("Required fields missing", { description: "Please fill in your name, email, and company." });
      return;
    }
    setErrors({});

    setSending(true);

    const subject = encodeURIComponent(`Enterprise Inquiry — ${company}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nTeam Size: ${teamSize || "Not specified"}\n\n${message || "I'd like to learn more about MotionMax Enterprise."}`
    );

    window.open(`mailto:sales@motionmax.io?subject=${subject}&body=${body}`, "_blank");

    toast.success("Email client opened", { description: "Your enterprise inquiry has been prepared. Please send the email to complete your request." });

    setSending(false);
    onOpenChange(false);
    setName("");
    setEmail("");
    setCompany("");
    setTeamSize("");
    setMessage("");
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Contact Sales
          </AlertDialogTitle>
          <AlertDialogDescription>
            Tell us about your organization and we'll craft a custom plan for your team.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <label htmlFor="ent-name" className="text-xs font-medium text-foreground">
              Full Name <span className="text-destructive">*</span>
            </label>
            <input
              id="ent-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); if (errors.name) setErrors(prev => ({ ...prev, name: undefined })); }}
              placeholder="Jane Smith"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "ent-name-error" : undefined}
              autoComplete="name"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {errors.name && <p id="ent-name-error" role="alert" className="mt-1 text-xs text-destructive">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="ent-email" className="text-xs font-medium text-foreground">
              Work Email <span className="text-destructive">*</span>
            </label>
            <input
              id="ent-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (errors.email) setErrors(prev => ({ ...prev, email: undefined })); }}
              placeholder="jane@company.com"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "ent-email-error" : undefined}
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {errors.email && <p id="ent-email-error" role="alert" className="mt-1 text-xs text-destructive">{errors.email}</p>}
          </div>
          <div>
            <label htmlFor="ent-company" className="text-xs font-medium text-foreground">
              Company <span className="text-destructive">*</span>
            </label>
            <input
              id="ent-company"
              type="text"
              value={company}
              onChange={(e) => { setCompany(e.target.value); if (errors.company) setErrors(prev => ({ ...prev, company: undefined })); }}
              placeholder="Acme Corp"
              aria-invalid={!!errors.company}
              aria-describedby={errors.company ? "ent-company-error" : undefined}
              autoComplete="organization"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {errors.company && <p id="ent-company-error" role="alert" className="mt-1 text-xs text-destructive">{errors.company}</p>}
          </div>
          <div>
            <label htmlFor="ent-size" className="text-xs font-medium text-foreground">
              Team Size
            </label>
            <select
              id="ent-size"
              value={teamSize}
              onChange={(e) => setTeamSize(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Select…</option>
              <option value="1-10">1–10</option>
              <option value="11-50">11–50</option>
              <option value="51-200">51–200</option>
              <option value="201-500">201–500</option>
              <option value="500+">500+</option>
            </select>
          </div>
          <div>
            <label htmlFor="ent-msg" className="text-xs font-medium text-foreground">
              Message
            </label>
            <textarea
              id="ent-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Tell us about your use case…"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button onClick={handleSubmit} disabled={sending}>
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Opening…
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Send Inquiry
              </>
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
