import os
import re

files_to_clean = [
    'src/components/admin/AdminPerformanceMetrics.tsx',
    'src/components/workspace/CreditEstimate.tsx',
    'src/components/workspace/DashboardQuickActions.tsx',
    'src/components/workspace/GenerationResult.tsx',
    'src/components/workspace/InspirationSelector.tsx',
    'src/components/workspace/StyleSelector.tsx',
    'src/components/workspace/VideoPlayer.tsx',
    'src/components/workspace/WorkspaceBreadcrumb.tsx',
    'src/pages/Dashboard.tsx',
    'src/pages/Landing.tsx',
    'src/pages/Usage.tsx',
    'src/lib/__tests__/planLimits.test.ts'
]

for file_path in files_to_clean:
    if not os.path.exists(file_path):
        continue
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Generic cleanups for storytelling lines
    # Admin metrics
    content = re.sub(r'\s*storytelling: number;', '', content)
    content = re.sub(r'\s*storytelling: \{ total: 0, completed: 0, totalTime: 0 \},', '', content)
    content = re.sub(r'\s*storytelling:\s*byType\.storytelling[^:]+:\s*0,', '', content)
    content = re.sub(r'\s*\{\s*type: "Storytelling",\s*avgTime: metrics\.avgTimeByType\.storytelling,\s*successRate: metrics\.successRateByType\.storytelling,\s*\},', '', content)
    
    # Unions and other generic
    content = re.sub(r' \| "storytelling"', '', content)
    content = re.sub(r'"storytelling" \| ', '', content)
    
    # Specifics
    content = re.sub(r'doc2video/storytelling', 'doc2video', content)
    content = re.sub(r'\s*\{ mode: "storytelling".*\n', '\n', content)
    content = re.sub(r'\s*projectType = "storytelling",\n', '\n', content)
    content = re.sub(r'\s*\{ id: "neil-gaiman".*\n', '\n', content)
    content = re.sub(r'Doc2Video, Storytelling, and Cinematic', 'Doc2Video, and Cinematic', content)
    content = re.sub(r'\s*"Sprinkling storytelling dust on your video...",\n', '\n', content)
    content = re.sub(r'\s*storytelling: "Visual Stories",\n', '\n', content)
    content = re.sub(r'\s*expect\(getCreditsRequired\("storytelling".*\n', '\n', content)
    content = re.sub(r'\s*expect\(getMultiplier\("storytelling"\)\)\.toBe\(1\);\n', '\n', content)
    content = re.sub(r'\s*"Try the Anime style for dynamic, expressive storytelling",\n', '\n', content)
    content = re.sub(r'\s*tag: "Storytelling",\n', '\n', content)
    content = re.sub(r'\s*mode: "storytelling",\n', '\n', content)
    content = re.sub(r'projectType === "storytelling" \? Clapperboard :', 'projectType === "smartflow" || projectType === "smart-flow" ? Wallpaper :', content)
    content = re.sub(r'const IconComponent = projectType === "storytelling" \? Clapperboard : projectType === "smartflow" \|\| projectType === "smart-flow" \? Wallpaper : Video;', 'const IconComponent = projectType === "smartflow" || projectType === "smart-flow" ? Wallpaper : Video;', content)

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Cleaned", file_path)
