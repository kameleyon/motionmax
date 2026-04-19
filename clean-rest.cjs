const fs = require('fs');

let f = 'src/components/admin/AdminPerformanceMetrics.tsx';
let content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*storytelling.*\n/g, '');
fs.writeFileSync(f, content);

f = 'src/components/workspace/CreditEstimate.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/doc2video\/storytelling/g, 'doc2video');
fs.writeFileSync(f, content);

f = 'src/components/workspace/DashboardQuickActions.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*storytelling.*\n/g, '');
fs.writeFileSync(f, content);

f = 'src/components/workspace/GenerationResult.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/  projectType = "storytelling",\n/g, '');
fs.writeFileSync(f, content);

f = 'src/components/workspace/InspirationSelector.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*Mythical storytelling.*\n/g, '');
fs.writeFileSync(f, content);

f = 'src/components/workspace/WorkspaceBreadcrumb.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*storytelling.*\n/g, '');
fs.writeFileSync(f, content);

f = 'src/pages/Landing.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*storytelling.*\n/g, '');
fs.writeFileSync(f, content);

f = 'src/pages/Usage.tsx';
content = fs.readFileSync(f, 'utf8');
content = content.replace(/.*const IconComponent = projectType === "storytelling".*\n/g, '                          const IconComponent = projectType === "smartflow" || projectType === "smart-flow" ? Wallpaper : Video;\n');
fs.writeFileSync(f, content);
