const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);

export function createAccountEmail({ kind, recipient, name, sandbox }, { from, replyTo, origin }) {
    if (kind !== 'premium') throw new Error('Unsupported account email kind');
    const subject = 'Your MicProbe Premium access is ready';
    const heading = 'Premium is linked to your account';
    const paragraphs = [
        'Your lifetime Premium access is now linked to this MicProbe account. Sign in with the same Google account to use it on another browser.',
        'You can view detailed guidance and export your reports. Your receipt and payment details are handled separately by Freemius.'
    ];
    if (sandbox) paragraphs.unshift('This is a sandbox test notification. No live purchase is being confirmed.');
    const greeting = name ? `Hi ${name},` : 'Hello,';
    const link = `${origin}/app`;
    const text = [greeting, heading, ...paragraphs, `Open MicProbe: ${link}`,
        'Need help? Reply to this email.'].join('\n\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f4f5f7;color:#1c2430;font-family:Arial,sans-serif;line-height:1.6">
<table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:white;border:1px solid #dce0e6;border-radius:12px"><tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold">MicProbe</p>
<p>${escapeHtml(greeting)}</p><h1 style="font-size:24px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
<p style="margin:28px 0"><a href="${escapeHtml(link)}" style="background:#225bd8;color:white;padding:12px 20px;border-radius:7px;text-decoration:none;display:inline-block">Open MicProbe</a></p>
<p style="color:#525d6d;font-size:14px">Need help? Reply to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
    return { from, to: [recipient], reply_to: replyTo, subject: sandbox ? `[Sandbox] ${subject}` : subject, html, text };
}
