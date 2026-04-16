window.tailwind = window.tailwind || {};

tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'on-tertiary-fixed-variant': '#3f4850',
        'secondary-container': '#bfd2fd',
        tertiary: '#3c454d',
        'on-error-container': '#93000a',
        'on-tertiary': '#ffffff',
        'surface-container-highest': '#e1e2e4',
        'error-container': '#ffdad6',
        'on-primary-container': '#c4d2ff',
        'inverse-surface': '#2e3132',
        'surface-container-lowest': '#ffffff',
        error: '#ba1a1a',
        'surface-container': '#edeef0',
        'surface-container-high': '#e7e8ea',
        outline: '#737685',
        'on-secondary-container': '#475a7e',
        'on-tertiary-fixed': '#141c24',
        secondary: '#4c5e83',
        'secondary-fixed-dim': '#b4c7f1',
        'surface-container-low': '#f3f4f6',
        'primary-container': '#0052cc',
        'surface-bright': '#f8f9fb',
        'on-primary-fixed': '#001848',
        'inverse-primary': '#b2c5ff',
        'tertiary-fixed-dim': '#bec7d2',
        'primary-fixed': '#dae2ff',
        primary: '#003d9b',
        'secondary-fixed': '#d7e2ff',
        'on-secondary-fixed': '#041b3c',
        'on-surface': '#191c1e',
        background: '#f8f9fb',
        'on-tertiary-container': '#cbd4df',
        'primary-fixed-dim': '#b2c5ff',
        'on-surface-variant': '#434654',
        'on-secondary-fixed-variant': '#34476a',
        'surface-tint': '#0c56d0',
        'inverse-on-surface': '#f0f1f3',
        'on-primary-fixed-variant': '#0040a2',
        'on-primary': '#ffffff',
        surface: '#f8f9fb',
        'surface-variant': '#e1e2e4',
        'outline-variant': '#c3c6d6',
        'tertiary-container': '#535c65',
        'primary-soft': '#eaf2ff',
        line: '#d8deee',
        ink: '#152033',
        muted: '#61708a'
      },
      fontFamily: {
        headline: ['Manrope'],
        body: ['Inter'],
        label: ['Inter']
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px'
      }
    }
  }
};
