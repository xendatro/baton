import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FileAudioIcon,
  type LucideIcon,
} from 'lucide-react';

/** Icon for a non-image attachment, by MIME type or extension. */
export function fileIcon(mimeType: string, filename: string): LucideIcon {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType.startsWith('video/')) return FileVideoIcon;
  if (mimeType.startsWith('audio/')) return FileAudioIcon;
  if (/zip|tar|gzip|x-7z|rar|compressed/.test(mimeType)) return FileArchiveIcon;
  if (/csv|spreadsheet|excel/.test(mimeType) || ['csv', 'xlsx', 'xls'].includes(ext)) {
    return FileSpreadsheetIcon;
  }
  if (
    /json|javascript|typescript|xml|x-sh|x-python/.test(mimeType) ||
    [
      'js',
      'ts',
      'tsx',
      'json',
      'py',
      'sh',
      'go',
      'rs',
      'rb',
      'java',
      'yml',
      'yaml',
      'toml',
    ].includes(ext)
  ) {
    return FileCodeIcon;
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/pdf' || ext === 'md') {
    return FileTextIcon;
  }
  return FileIcon;
}
