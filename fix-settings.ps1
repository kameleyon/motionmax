$f = 'src\pages\Settings.tsx'
$c = [System.IO.File]::ReadAllText($f)

# 1. Add Mail to lucide-react imports
$c = $c.Replace(
  '  AlertTriangle,' + "`n} from `"lucide-react`";",
  '  AlertTriangle,' + "`n  Mail,`n} from `"lucide-react`";"
)

# 2. Make DELETE confirmation case-insensitive
$c = $c.Replace(
  'if (deleteConfirmText !== "DELETE") return;',
  'if (deleteConfirmText.toUpperCase() !== "DELETE") return;'
)
$c = $c.Replace(
  'disabled={deleteConfirmText !== "DELETE" || isDeletingAccount}',
  'disabled={deleteConfirmText.toUpperCase() !== "DELETE" || isDeletingAccount}'
)

# 3. Add emailChangePending / pendingEmail state after deleteConfirmText state
$c = $c.Replace(
  '  const [deleteConfirmText, setDeleteConfirmText] = useState("");',
  '  const [deleteConfirmText, setDeleteConfirmText] = useState("");' + "`n  const [emailChangePending, setEmailChangePending] = useState(false);`n  const [pendingEmail, setPendingEmail] = useState(`"`");"
)

# 4. Set pending state in handleChangeEmail after success toast
$c = $c.Replace(
  '      toast.success("Confirmation email sent. Check your new inbox to confirm the change.");',
  '      toast.success("Confirmation email sent. Check your new inbox to confirm the change.");' + "`n      setEmailChangePending(true);`n      setPendingEmail(newEmail.trim());"
)

# 5. Add maxLength=50 to display name Input
$c = $c.Replace(
  '                            onChange={(e) => setDisplayName(e.target.value)}',
  '                            onChange={(e) => setDisplayName(e.target.value)}' + "`n                            maxLength={50}"
)

# 6. Insert email-pending banner before Update Email button
$c = $c.Replace(
  '                        <Button onClick={handleChangeEmail}',
  '                        {emailChangePending && (' + "`n                          <div className=`"flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mb-3`">`n                            <Mail className=`"h-3.5 w-3.5 shrink-0 mt-0.5`" />`n                            <span>Confirmation email sent to <strong>{pendingEmail}</strong>. Check your inbox to complete the change.</span>`n                          </div>`n                        )}`n                        <Button onClick={handleChangeEmail}"
)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f"
