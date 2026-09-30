param(
    # Supply the original, unsplit op-expr-revision-convo.md.
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $SourcePath))
$documents = @(
    @{ Name = 'foldkit-ir-design'; Title = 'Foldkit Expr and Operation design'; Marker = 'Very much. After looking at' },
    @{ Name = 'gen2-semantic-kernel'; Title = 'Gen2 semantic kernel and typed laws'; Marker = 'Yes. After looking through `gen2`' },
    @{ Name = 'reuse-strategy'; Title = 'Reuse and adaptation strategy'; Marker = 'Yes. I think we can reuse a **surprisingly large amount**' },
    @{ Name = 'cruster-backend'; Title = 'Optional Cruster distributed backend'; Marker = 'Yes — **very much**, but I would use Cruster' },
    @{ Name = 'compiler-design-revision'; Title = 'Revised compiler design'; Marker = '# Effect Native — Revised Implementation Plan' },
    @{ Name = 'implementation-milestones'; Title = 'Revised implementation milestones'; Marker = '# 14. Milestone 0 — bootstrap the semantic kernel' },
    @{ Name = 'conformance-and-diagnostics'; Title = 'Conformance, diagnostics, and the fullstack target'; Marker = '# 41. Testing architecture from day one' }
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
    throw 'Source must be the original, unsplit conversation.'
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
    $links = @()
    $titleAnchor = $document.Title.ToLowerInvariant() -replace '[^\p{L}\p{N}_\- ]', '' -replace ' ', '-'
    $anchors = @{ $titleAnchor = 0; contents = 0 }
    $inFence = $false
    foreach ($line in ($contents -split '\r?\n')) {
        if ($line -match '^```') { $inFence = -not $inFence; continue }
        if (-not $inFence -and $line -match '^#{1,3} (.+)$') {
            $heading = $Matches[1]
            $anchor = $heading.ToLowerInvariant() -replace '[^\p{L}\p{N}_\- ]', '' -replace ' ', '-'
            if ($anchors.ContainsKey($anchor)) {
                $anchors[$anchor]++
                $suffix = $anchors[$anchor]
                $anchor = "$anchor-$suffix"
            } else {
                $anchors[$anchor] = 0
            }
            $links += "- [$heading](#$anchor)"
        }
    }
    $header = @"
# $($document.Title)

[Roadmap](../PLAN.md) · [Documentation index](README.md) · [Revision overview](op-expr-revision-convo.md)

This document preserves part of the later design conversation. Read the revision overview for how it updates earlier proposals. Examples and upstream API, repository, and licensing claims are historical design material, not verified current facts or implemented guarantees.

## Contents

$($links -join "`n")

---

"@
    $path = Join-Path $OutputDirectory "$($document.Name).md"
    [System.IO.File]::WriteAllText($path, $header + "`n" + $contents, [System.Text.UTF8Encoding]::new($false))
    Write-Output "Extracted $($document.Name).md ($($contents.Length) characters)"
}
