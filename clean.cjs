const fs = require('fs');
const path = require('path');

function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // Types
  content = content.replace(/ \| "storytelling"/g, '');
  content = content.replace(/"storytelling" \| /g, '');
  
  // Specific switches
  content = content.replace(/case "storytelling":\s*return [^;]+;/g, '');
  content = content.replace(/case "storytelling":\s*return [^:]+:/g, '');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated', filePath);
  }
}

const files = [
  'src/components/dashboard/GenerationQueueStatus.tsx',
  'src/components/projects/ProjectsGridView.tsx',
  'src/components/workspace/CreditCostDisplay.tsx',
  'src/components/workspace/CreditEstimate.tsx',
  'src/components/workspace/DashboardQuickActions.tsx',
  'src/components/workspace/GenerationResult.tsx',
  'src/components/workspace/WorkspaceBreadcrumb.tsx',
  'src/pages/Dashboard.tsx',
  'src/pages/Landing.tsx',
  'src/pages/Projects.tsx',
  'src/pages/Usage.tsx',
  'src/hooks/generation/callPhase.ts',
  'src/hooks/generation/types.ts',
  'src/hooks/useWorkspaceSubscription.ts'
];

files.forEach(f => processFile(path.join(__dirname, f)));
