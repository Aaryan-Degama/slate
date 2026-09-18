import { useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import NewRequest from './NewRequest'
import StudentDashboard from './StudentDashboard'
import TeacherDashboard from './TeacherDashboard'
import AdminDashboard from './AdminDashboard'
import { useMyProfile } from './lib/useMyProfile'
import './App.css'

type FacultyTab = 'teaching' | 'new-request'

function App() {
  const [facultyTab, setFacultyTab] = useState<FacultyTab>('teaching')
  const { profile, loading, linkSection, linkFacultyName } = useMyProfile()

  return (
    <Authenticator>
      {({ signOut, user }) => {
        if (loading || !profile) {
          return (
            <div className="app-shell">
              <p>Loading...</p>
            </div>
          )
        }

        if (profile.role === 'STUDENT') {
          return (
            <div className="app-shell">
              <nav className="tabs">
                <span className="app-title">Slate</span>
                <button className="sign-out" onClick={signOut}>
                  Sign out
                </button>
              </nav>
              <StudentDashboard profile={profile} linkSection={linkSection} />
            </div>
          )
        }

        if (profile.role === 'ADMIN') {
          return (
            <div className="app-shell">
              <nav className="tabs">
                <span className="app-title">Slate — Admin</span>
                <button className="sign-out" onClick={signOut}>
                  Sign out
                </button>
              </nav>
              <AdminDashboard />
            </div>
          )
        }

        // FACULTY
        return (
          <div className="app-shell">
            <nav className="tabs">
              <span className="app-title">Slate</span>
              <button
                className={facultyTab === 'teaching' ? 'active' : ''}
                onClick={() => setFacultyTab('teaching')}
              >
                My Teaching Timetable
              </button>
              <button
                className={facultyTab === 'new-request' ? 'active' : ''}
                onClick={() => setFacultyTab('new-request')}
              >
                Schedule a Session
              </button>
              <button className="sign-out" onClick={signOut}>
                Sign out
              </button>
            </nav>

            {facultyTab === 'teaching' && (
              <TeacherDashboard profile={profile} linkFacultyName={linkFacultyName} />
            )}
            {facultyTab === 'new-request' && <NewRequest requesterId={user?.userId ?? ''} />}
          </div>
        )
      }}
    </Authenticator>
  )
}

export default App
