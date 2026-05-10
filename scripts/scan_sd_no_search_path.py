"""One-shot scanner: list every SECURITY DEFINER function definition in
supabase/migrations/ whose header lacks SET search_path. Tries to model
the "current live state" by applying definitions in migration order and
tracking the latest definition per (function-name, args).
Used to audit C-6-5 (Shield S-009 + Atlas) findings.
"""
import re
import glob


def parse_args(args_text):
    """Coarse arg-signature normalisation. Returns the raw args block."""
    return re.sub(r'\s+', ' ', args_text).strip().lower()


def main():
    files = sorted(glob.glob('supabase/migrations/*.sql'))
    # Per (name_lower, arg_signature_lower) -> latest (file, has_search_path)
    state = {}
    for f in files:
        txt = open(f, 'r', encoding='utf-8', errors='ignore').read()
        # strip line comments to avoid false-positives in comment text
        nocomments = re.sub(r'--[^\n]*', '', txt)
        # match CREATE [OR REPLACE] FUNCTION <name> ( ... ) ... AS $tag$
        # tag can be empty or alphanumeric
        for m in re.finditer(
            r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_."]+)\s*\(([^()]*?)\)\s*([^$]*?)AS\s+\$([A-Za-z0-9_]*)\$',
            nocomments,
            re.IGNORECASE | re.DOTALL,
        ):
            name = m.group(1).strip().lower()
            if not name.startswith('public.') and '.' not in name:
                name = 'public.' + name
            args = parse_args(m.group(2))
            header = m.group(3)
            has_sd = bool(re.search(r'SECURITY\s+DEFINER', header, re.IGNORECASE))
            if not has_sd:
                continue
            has_sp = bool(re.search(r'SET\s+search_path', header, re.IGNORECASE))
            key = (name, args)
            state[key] = (f, has_sp)
        # also handle DROP FUNCTION removing a definition
        for m in re.finditer(
            r'DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."]+)\s*\(([^()]*?)\)',
            nocomments,
            re.IGNORECASE,
        ):
            name = m.group(1).strip().lower()
            if not name.startswith('public.') and '.' not in name:
                name = 'public.' + name
            args = parse_args(m.group(2))
            state.pop((name, args), None)

    # Report current live state
    broken = []
    for (name, args), (f, has_sp) in sorted(state.items()):
        if not has_sp:
            broken.append((name, args, f))
    if not broken:
        print('CLEAN: every currently-live SECURITY DEFINER function has search_path pinned.')
        return
    print(f'BROKEN ({len(broken)} currently-live SECURITY DEFINER functions lack search_path):')
    for name, args, f in broken:
        print(f'  - {name}({args})    last defined in {f}')


if __name__ == '__main__':
    main()
