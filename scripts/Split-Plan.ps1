param(
    # Supply the original, unsplit PLAN.md (not the new roadmap).
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $SourcePath))
$documents = @(
    @{ Name = 'architecture'; Title = 'Compiler architecture'; Marker = '# Effect Native' },
    @{ Name = 'rpc-mvp'; Title = 'RPC MVP'; Marker = 'Yes. In fact, I think' },
    @{ Name = 'rpc-protocol'; Title = 'RPC protocol and transports'; Marker = 'Yes. These are really the pieces' },
    @{ Name = 'compiler-api'; Title = 'Compiler library API and CLI'; Marker = 'Yes. I think that should be' },
    @{ Name = 'foldkit-ssr'; Title = 'Foldkit SSR and SSG'; Marker = 'Yes. I think **Foldkit SSR' },
    @{ Name = 'foldkit-remote'; Title = 'Foldkit Remote and SQL'; Marker = 'Yes. **`foldkit-remote`' }
)

# Validate every boundary and destination before writing any files.
$previous = -1
foreach ($document in $documents) {
    $start = $source.IndexOf($document.Marker, [StringComparison]::Ordinal)
    if ($start -le $previous -or $source.IndexOf($document.Marker, $start + 1, [StringComparison]::Ordinal) -ge 0) {
        throw "Expected one ordered occurrence of: $($document.Marker)"
    }
    $document.Start = $start
    $previous = $start
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory "$($document.Name).md")) {
        throw "Destination already exists: $($document.Name).md"
    }
}
if ($documents[0].Start -ne 0) {
    throw 'Source must be the original PLAN.md, starting with # Effect Native.'
}

$parts = @()
for ($index = 0; $index -lt $documents.Count; $index++) {
    $end = if ($index + 1 -lt $documents.Count) { $documents[$index + 1].Start } else { $source.Length }
    $parts += $source.Substring($documents[$index].Start, $end - $documents[$index].Start)
}
if (($parts -join '') -cne $source) {
    throw 'Content preservation check failed.'
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
for ($index = 0; $index -lt $documents.Count; $index++) {
    $document = $documents[$index]
    $contents = $parts[$index]
    # Generated section links skip fenced examples. Original prose and examples stay intact.
    $links = @()
    $inFence = $false
    foreach ($line in ($contents -split '\r?\n')) {
        if ($line -match '^```') { $inFence = -not $inFence; continue }
        if (-not $inFence -and $line -match '^#{1,2} (.+)$') {
            $heading = $Matches[1]
            $anchor = $heading.ToLowerInvariant() -replace '[^\p{L}\p{N}_\- ]', '' -replace ' ', '-'
            $links += "- [$heading](#$anchor)"
        }
    }
    $header = @"
# $($document.Title)

[Roadmap](../PLAN.md) · [Documentation index](README.md)

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

$($links -join "`n")

---

"@
    $path = Join-Path $OutputDirectory "$($document.Name).md"
    [System.IO.File]::WriteAllText($path, $header + "`n" + $contents, [System.Text.UTF8Encoding]::new($false))
    Write-Output "Extracted $($document.Name).md ($($contents.Length) characters)"
}
