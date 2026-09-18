import { useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import NewRequest from './NewRequest'
import StudentDashboard from './StudentDashboard'
import TeacherDashboard from './TeacherDashboard'
import AdminDashboard from './AdminDashboard'
import AdminTimetableEditor from './AdminTimetableEditor'
import AdminUpload from './AdminUpload'
import { useMyProfile, type Profile } from './lib/useMyProfile'
import './App.css'

type FacultyTab = 'teaching' | 'new-request'
type AdminTab = 'data' | 'upload' | 'edit'

function AppShell({
  profile,
  onSignOut,
  navItems,
  children,
}: {
  profile: Profile
  onSignOut: () => void
  navItems: { key: string; label: string; active: boolean; onClick: () => void }[]
  children: React.ReactNode
}) {
  const rolePillClass =
    profile.role === 'ADMIN'
      ? 'role-pill admin'
      : profile.role === 'FACULTY'
        ? 'role-pill faculty'
        : 'role-pill student'

  return (
    <div className="app-shell">
      <header className="topbar-nav">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>Slate</span>
        </div>
        <nav className="top-nav-items">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`nav-item${item.active ? ' active' : ''}`}
              onClick={item.onClick}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar">{profile.email.charAt(0).toUpperCase()}</span>
          <div>
            <strong>{profile.email}</strong>
            <small>
              <span className={rolePillClass}>{profile.role}</span>
            </small>
          </div>
        </div>
        <button className="logout" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main className="admin-content">{children}</main>
    </div>
  )
}

function App() {
  const [facultyTab, setFacultyTab] = useState<FacultyTab>('teaching')
  const [adminTab, setAdminTab] = useState<AdminTab>('data')
  const { profile, loading, linkSection, linkFacultyName } = useMyProfile()

  return (
    <Authenticator>
      {({ signOut, user }) => {
        if (loading || !profile) {
          return (
            <div className="app-shell">
              <main className="admin-content">
                <p>Loading...</p>
              </main>
            </div>
          )
        }

        if (profile.role === 'STUDENT') {
          return (
            <AppShell
              profile={profile}
              onSignOut={() => signOut?.()}
              navItems={[{ key: 'timetable', label: 'My Timetable', active: true, onClick: () => {} }]}
            >
              <StudentDashboard profile={profile} linkSection={linkSection} />
            </AppShell>
          )
        }

        if (profile.role === 'ADMIN') {
          return (
            <AppShell
              profile={profile}
              onSignOut={() => signOut?.()}
              navItems={[
                {
                  key: 'data',
                  label: 'Ingested Data',
                  active: adminTab === 'data',
                  onClick: () => setAdminTab('data'),
                },
                {
                  key: 'upload',
                  label: 'Upload Data',
                  active: adminTab === 'upload',
                  onClick: () => setAdminTab('upload'),
                },
                {
                  key: 'edit',
                  label: 'Correct Timetable',
                  active: adminTab === 'edit',
                  onClick: () => setAdminTab('edit'),
                },
              ]}
            >
              {adminTab === 'data' && <AdminDashboard />}
              {adminTab === 'upload' && <AdminUpload onDone={() => setAdminTab('edit')} />}
              {adminTab === 'edit' && <AdminTimetableEditor />}
            </AppShell>
          )
        }

        // FACULTY
        return (
          <AppShell
            profile={profile}
            onSignOut={() => signOut?.()}
            navItems={[
              {
                key: 'teaching',
                label: 'My Teaching Timetable',
                active: facultyTab === 'teaching',
                onClick: () => setFacultyTab('teaching'),
              },
              {
                key: 'new-request',
                label: 'Schedule a Session',
                active: facultyTab === 'new-request',
                onClick: () => setFacultyTab('new-request'),
              },
            ]}
          >
            {facultyTab === 'teaching' && (
              <TeacherDashboard profile={profile} linkFacultyName={linkFacultyName} />
            )}
            {facultyTab === 'new-request' && <NewRequest requesterId={user?.userId ?? ''} />}
          </AppShell>
        )
      }}
    </Authenticator>
  )
}

export default App
