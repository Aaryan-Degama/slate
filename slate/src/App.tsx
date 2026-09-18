import { Authenticator } from '@aws-amplify/ui-react'
import NewRequest from './NewRequest'
import './App.css'

function App() {
  return (
    <Authenticator>
      {({ user }) => <NewRequest requesterId={user?.userId ?? ''} />}
    </Authenticator>
  )
}

export default App
