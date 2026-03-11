/**
 * apply-email-templates.mjs
 * Applies minimal, modern email templates to Supabase Auth.
 */

const TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";
const REF = "ayjbvcikuwknqdrpsdmj";
const API = `https://api.supabase.com/v1/projects/${REF}/config/auth`;

// ── Shared styles inline ──
const base = (content) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);max-width:480px;width:100%;">
        <tr><td style="background:#000;padding:24px 40px;text-align:center;">
          <span style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px;">MotionMax</span>
        </td></tr>
        <tr><td style="padding:36px 40px 28px;">${content}</td></tr>
        <tr><td style="padding:16px 40px 28px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#aaa;text-align:center;">This email was sent by MotionMax &middot; <a href="https://motionmax.io" style="color:#aaa;text-decoration:none;">motionmax.io</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:-.2px;">${label}</a>`;

const h1 = (text) =>
  `<h1 style="margin:0 0 10px;font-size:22px;font-weight:600;color:#111;letter-spacing:-.4px;">${text}</h1>`;

const p = (text) =>
  `<p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">${text}</p>`;

// ── 1. Password Reset (6-digit OTP) ──
const recovery = base(`
  ${h1("Reset your password")}
  ${p("Enter this code to reset your password. It expires in 60 minutes.")}
  <div style="background:#f8f8f8;border-radius:8px;padding:24px 16px;text-align:center;margin:0 0 24px;letter-spacing:8px;">
    <span style="font-size:38px;font-weight:700;color:#111;font-family:'Courier New',Courier,monospace;">{{ .Token }}</span>
  </div>
  <p style="margin:0 0 20px;font-size:13px;color:#aaa;text-align:center;">Or use the link below to reset directly</p>
  <div style="text-align:center;">${btn("{{ .ConfirmationURL }}", "Reset Password")}</div>
  <p style="margin:20px 0 0;font-size:12px;color:#bbb;text-align:center;">Didn't request this? You can safely ignore this email.</p>
`);

// ── 2. Email Confirmation (after sign up) ──
const confirmation = base(`
  ${h1("Verify your email")}
  ${p("Thanks for signing up. Click the button below to verify your email address and activate your account.")}
  <div style="text-align:center;">${btn("{{ .ConfirmationURL }}", "Verify Email")}</div>
  <p style="margin:20px 0 0;font-size:12px;color:#bbb;text-align:center;">If you didn't create an account, you can ignore this email.</p>
`);

// ── 3. Password Changed Notification ──
const passwordChanged = base(`
  ${h1("Your password was changed")}
  ${p("This is a confirmation that the password for your MotionMax account was successfully updated.")}
  <p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.6;">If you made this change, no further action is needed.</p>
  <div style="text-align:center;">${btn("https://motionmax.io/auth", "Secure My Account")}</div>
  <p style="margin:20px 0 0;font-size:12px;color:#bbb;text-align:center;">If you didn't change your password, reset it immediately.</p>
`);

// ── 4. Email Changed Notification ──
const emailChanged = base(`
  ${h1("Your email was updated")}
  ${p("This is a confirmation that the email address for your MotionMax account has been changed.")}
  <p style="margin:0 0 20px;font-size:14px;color:#666;line-height:1.6;">You will now receive all account emails at your new address.</p>
  <div style="text-align:center;">${btn("https://motionmax.io/settings", "Manage Account")}</div>
  <p style="margin:20px 0 0;font-size:12px;color:#bbb;text-align:center;">If you didn't make this change, contact support immediately.</p>
`);

// ── Apply via Management API ──
const payload = {
  // Lock the site URL to motionmax.io so all email links point to production
  site_url: "https://motionmax.io",

  // 6-digit OTP length
  mailer_otp_length: 6,

  // Subjects
  mailer_subjects_recovery: "Reset your MotionMax password",
  mailer_subjects_confirmation: "Verify your MotionMax email",
  mailer_subjects_password_changed_notification: "Your MotionMax password was changed",
  mailer_subjects_email_changed_notification: "Your MotionMax email was updated",

  // Templates
  mailer_templates_recovery_content: recovery,
  mailer_templates_confirmation_content: confirmation,
  mailer_templates_password_changed_notification_content: passwordChanged,
  mailer_templates_email_changed_notification_content: emailChanged,

  // Enable change notifications
  mailer_notifications_password_changed_enabled: true,
  mailer_notifications_email_changed_enabled: true,
};

const res = await fetch(API, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (res.ok) {
  console.log("✅ Email templates applied successfully!");
  const data = JSON.parse(text);
  console.log("  otp_length:", data.mailer_otp_length);
  console.log("  recovery subject:", data.mailer_subjects_recovery);
  console.log("  confirmation subject:", data.mailer_subjects_confirmation);
  console.log("  password_changed subject:", data.mailer_subjects_password_changed_notification);
  console.log("  email_changed subject:", data.mailer_subjects_email_changed_notification);
  console.log("  notifications_password_changed:", data.mailer_notifications_password_changed_enabled);
  console.log("  notifications_email_changed:", data.mailer_notifications_email_changed_enabled);
} else {
  console.error("Error:", res.status, text);
}
