import sys
with open('src/pages/Usage.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

import re
text = re.sub(
    r'const IconComponent = projectType === "storytelling"[\s\S]*?: projectType === "smartflow"',
    'const IconComponent = projectType === "smartflow"',
    text
)

with open('src/pages/Usage.tsx', 'w', encoding='utf-8') as f:
    f.write(text)
