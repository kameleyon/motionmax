## --- 1. Fix worker/package.json BOM (write UTF-8 without BOM) ---
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$pjContent = '{
  "name": "motionmax-worker",
  "version": "1.0.0",
  "description": "Background worker for processing video generation jobs on Render.",
  "main": "src/index.ts",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.6",
    "dotenv": "^16.4.7",
    "fluent-ffmpeg": "^2.1.3",
    "openai": "^4.77.0",
    "uuid": "^11.0.3"
  },
  "devDependencies": {
    "@types/fluent-ffmpeg": "^2.1.27",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}'
[System.IO.File]::WriteAllText("$PWD\worker\package.json", $pjContent, $utf8NoBom)
Write-Host "Fixed: worker/package.json (no BOM)"

## --- 2. App.tsx: add QueryCache + MutationCache for global error logging ---
$f = 'src\App.tsx'
$c = [System.IO.File]::ReadAllText($f)

# Add QueryCache and MutationCache imports
$c = $c.Replace(
  'import { QueryClient, QueryClientProvider } from "@tanstack/react-query";',
  'import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";'
)

# Replace simple QueryClient instantiation with one that has global error handlers
$c = $c.Replace(
  'const queryClient = new QueryClient();',
  'const queryClient = new QueryClient({' + "`n  queryCache: new QueryCache({`n    onError: (error) => console.error('[QueryClient:Query]', error),`n  }),`n  mutationCache: new MutationCache({`n    onError: (error) => console.error('[QueryClient:Mutation]', error),`n  }),`n});"
)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Fixed: $f"
