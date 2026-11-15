import './globals.css';

export const metadata = {
  title: 'AutoClip – potong video panjang jadi klip viral',
  description: 'Ubah video panjang jadi klip vertikal 9:16 dengan caption otomatis.',
};

export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#0e0f13' };

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
