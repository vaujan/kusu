if (import.meta.env.MODE === 'tauri') {
  const { initializeTauriPreview } = await import('./tauri-preview')
  await initializeTauriPreview()
} else if (import.meta.env.DEV) {
  await import('./dev-tools')
}

await import('./main')
