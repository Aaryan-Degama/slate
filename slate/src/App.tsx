import { useState } from 'react'
import { Authenticator, ThemeProvider, useAuthenticator, type Theme } from '@aws-amplify/ui-react'
import NewRequest from './NewRequest'
import MyBatch from './MyBatch'
import StudentDashboard from './StudentDashboard'
import AdminDashboard from './AdminDashboard'
import AdminTimetableEditor from './AdminTimetableEditor'
import AdminUpload from './AdminUpload'
import AdminStudents from './AdminStudents'
import AdminClassReps from './AdminClassReps'
import AdminActivity from './AdminActivity'
import AdminEnrollments from './AdminEnrollments'
import { useClassReps } from './lib/classReps'
import { useMyProfile, type Profile } from './lib/useMyProfile'
import './App.css'

type StudentTab = 'timetable' | 'batch' | 'find'
type AdminTab = 'data' | 'upload' | 'students' | 'enrollments' | 'edit' | 'reps' | 'activity'

function AppShell({
  profile,
  isCr = false,
  onSignOut,
  navItems,
  children,
}: {
  profile: Profile
  isCr?: boolean
  onSignOut: () => void
  navItems: { key: string; label: string; active: boolean; onClick: () => void }[]
  children: React.ReactNode
}) {
  const rolePillClass = profile.role === 'ADMIN' ? 'role-pill admin' : 'role-pill student'
  const roleLabel = profile.role === 'ADMIN' ? 'ADMIN' : isCr ? 'CR' : 'STUDENT'

  return (
    <div className="app-shell">
      <header className="topbar-nav">
        <div className="brand">
          <img src="/logo.svg" alt="Slate" className="brand-mark" />
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
              <span className={rolePillClass}>{roleLabel}</span>
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

// Reskins Amplify UI's default theme to match Slate's own design tokens
// (index.css) — colors, font and radius only. Sign-in/sign-up/reset
// behavior is entirely Amplify's; nothing here changes what it does.
const amplifyTheme: Theme = {
  name: 'slate-theme',
  tokens: {
    fonts: {
      default: {
        variable: { value: 'DM Sans, system-ui, sans-serif' },
        static: { value: 'DM Sans, system-ui, sans-serif' },
      },
    },
    radii: {
      small: { value: '7px' },
      medium: { value: '7px' },
      large: { value: '10px' },
    },
    components: {
      authenticator: {
        router: {
          borderColor: { value: '#e3ebe7' },
          borderWidth: { value: '1px' },
          boxShadow: { value: '0 4px 17px rgba(23, 60, 48, 0.06)' },
        },
      },
      button: {
        primary: {
          backgroundColor: { value: '#187c55' },
          _hover: { backgroundColor: { value: '#116c48' } },
          _focus: { backgroundColor: { value: '#116c48' } },
          _active: { backgroundColor: { value: '#116c48' } },
        },
        link: {
          color: { value: '#187c55' },
          _hover: { color: { value: '#116c48' } },
        },
      },
      tabs: {
        item: {
          _active: {
            color: { value: '#187c55' },
            borderColor: { value: '#187c55' },
          },
        },
      },
      fieldcontrol: {
        _focus: {
          borderColor: { value: '#299265' },
          boxShadow: { value: '0 0 0 3px #d9f2e4' },
        },
      },
    },
  },
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-shell">
      <section className="login-intro">
        <div className="brand">
          <img src="/logo.svg" alt="Slate" className="brand-mark" />
          <span>Slate</span>
        </div>
        <div>
          <p className="eyebrow">IIIT Allahabad</p>
          <h1>Every timetable change, in one place.</h1>
          <p className="intro-copy">
            A cancelled lecture, a makeup class, a moved session — agreed between a professor and
            a CR, seen instantly by every section it touches. No more WhatsApp polls.
          </p>
        </div>
        <div className="security-note">
          <span>◈</span>
          <div>
            <strong>Restricted to IIITA accounts</strong>
            <br />
            Sign in with your @iiita.ac.in email.
          </div>
        </div>
      </section>
      <section className="login-panel">{children}</section>
    </div>
  )
}

// The split-screen shell (AuthShell) is only for the sign-in form. Once
// authenticated, Authenticator's children take over the whole page, so we
// use useAuthenticator to tell the two states apart and only wrap the
// former — the shell must not wrap the signed-in app itself.
function AuthGate() {
  const { authStatus } = useAuthenticator((context) => [context.authStatus])
  if (authStatus === 'authenticated') {
    return (
      <Authenticator>
        {({ signOut, user }) =>
          user ? <SignedIn key={user.userId} userId={user.userId} signOut={() => signOut?.()} /> : <></>
        }
      </Authenticator>
    )
  }
  return (
    <AuthShell>
      <Authenticator />
    </AuthShell>
  )
}

function App() {
  return (
    <ThemeProvider theme={amplifyTheme}>
      <Authenticator.Provider>
        <AuthGate />
      </Authenticator.Provider>
    </ThemeProvider>
  )
}

// Mounted only once someone is signed in (and remounted per user), so the
// profile always loads for the current login.
function SignedIn({ userId, signOut }: { userId: string; signOut: () => void }) {
  const [studentTab, setStudentTab] = useState<StudentTab>('timetable')
  const [adminTab, setAdminTab] = useState<AdminTab>('data')
  const { profile, loading, error, linkSection, markChangesSeen } = useMyProfile(userId)
  const { reps, reload: reloadReps, error: repsError } = useClassReps()

  if (loading || !profile) {
    return (
      <div className="app-shell">
        <main className="admin-content">
          {error ? (
            <>
              <p className="error">Couldn't load your profile: {error}</p>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <p>Loading...</p>
          )}
        </main>
      </div>
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
            key: 'students',
            label: 'Students',
            active: adminTab === 'students',
            onClick: () => setAdminTab('students'),
          },
          {
            key: 'enrollments',
            label: 'Enrollments',
            active: adminTab === 'enrollments',
            onClick: () => setAdminTab('enrollments'),
          },
          {
            key: 'edit',
            label: 'Correct Timetable',
            active: adminTab === 'edit',
            onClick: () => setAdminTab('edit'),
          },
          {
            key: 'reps',
            label: 'Class Reps',
            active: adminTab === 'reps',
            onClick: () => setAdminTab('reps'),
          },
          {
            key: 'activity',
            label: 'Activity',
            active: adminTab === 'activity',
            onClick: () => setAdminTab('activity'),
          },
        ]}
      >
        {adminTab === 'data' && <AdminDashboard onOpenStudents={() => setAdminTab('students')} />}
        {adminTab === 'upload' && <AdminUpload onDone={() => setAdminTab('edit')} />}
        {adminTab === 'students' && <AdminStudents />}
        {adminTab === 'edit' && <AdminTimetableEditor />}
        {adminTab === 'reps' && <AdminClassReps />}
        {adminTab === 'activity' && <AdminActivity />}
        {adminTab === 'enrollments' && <AdminEnrollments />}
      </AppShell>
    )
  }

  // Everyone else is a student (any old FACULTY rows included); the CR is
  // a student who has claimed their section.
  const isCr = Boolean(reps?.some((r) => r.sub === userId))
  return (
    <AppShell
      profile={profile}
      isCr={isCr}
      onSignOut={() => signOut?.()}
      navItems={[
        {
          key: 'timetable',
          label: 'My Timetable',
          active: studentTab === 'timetable',
          onClick: () => setStudentTab('timetable'),
        },
        {
          key: 'batch',
          label: 'My Batch',
          active: studentTab === 'batch',
          onClick: () => setStudentTab('batch'),
        },
        // Changing the timetable is a CR tool; students just see the result.
        ...(isCr
          ? [
              {
                key: 'find',
                label: 'Make a change',
                active: studentTab === 'find',
                onClick: () => setStudentTab('find'),
              },
            ]
          : []),
      ]}
    >
      {studentTab === 'timetable' && (
        <StudentDashboard
          profile={profile}
          linkSection={linkSection}
          userId={userId}
          reps={reps}
          reloadReps={reloadReps}
          repsError={repsError}
          seenAt={profile.changesSeenAt}
          markSeen={markChangesSeen}
        />
      )}
      {studentTab === 'batch' && <MyBatch />}
      {studentTab === 'find' && isCr && <NewRequest mySection={profile.linkedSection} isCr={isCr} />}
    </AppShell>
  )
}

export default App
