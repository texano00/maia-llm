# User identifications
* The main goal of maiallm is to not gather personal information in order to make money, it is instead to avoid that and give the user jsut what he/she needs without stealing him/her data like useless signin.
* this goal of the project, promoted directly from the founder has to be reflacted in the motto as well git readme file to be shared to the worlwide that we care about people privacy and moreover tha project is completerly an really OPEN & FREE (not like commercial product that call itself "open<something>", we are really open and free!)
* the only information we must retrieve of each users, to guarantee the improvement of the maiallm qualities, are
* unique ID (maybe composed by multiple information that could make it unique to identify a specific user using a specifi device)
* Foreach uniqueID we need to collect any usefull information from the device, e.g. OS, device type, etc, as well all the IPs addressed used over the time
In this way, that uniqueID will be associated to the telemetry data continuosly ingested so we can associated telemtry to a specific uniquID user.

#  Catalogue Estimation/Evaluation
* once the user select a model from the catalogue, regardless if it is advanced or guided mode, a popup has to be showed
* that popup, should first ask the user the "power" expected using an horizontal slider from low to high. While sliding it should appear an estimation of estimated token ouput rate (TPM)

# Telemetria
* the telemtry collect also the effective token per second (TPM) foreach user.
* That telemetry, for now is only a  passive collected information that can be visible inside the pvt.maiallm.com backoffice. That visibility is visible inside each user, and than foreach runned models
* in the future, this info will be used to create more precise estimations during model provisioning together with home much time it took the same model to be started and be up&running

# models capabilities
* for now, we provided only text to text generation, Need to provide also the "Text to Image" as well "image to text"/image to image models availability to be run on rented gpu and use them inside the chat


# Alerts & notifications
* A sx dell'icona "i" esistente in alto a dx, creare icona delle notifiche
* Questa iconcina di notifica può essere gialla o rossa in base all'entità della notifica
* Alcune anomalie possono essere ad esempio ** apikey vast ai o HF non funzionanti o assenti
** vast.ai wallet under 2$ (this 2$ is the default thresshold but it should be configured also in the user settings)
* questa nuova icona di notifiche, se cliccata apre la lista delle notifiche con eventuale CTA disponibile e link alla sezione interna di maiaLLM per agevolare l'azione
* a fianco della stessa icona di notifiche, aggiungere una nuova icona col simbolo dei soldi e dentro la stessa icona mostra il credito residuo su vast.ai. Cliccando non succede niente.

# come sapere se c'è almeno un modello running 
* nella nuvoa sezione "models" nella sidenav di SX, a fianco della label "models" mostrare un icona verde lampeggiante se c'è almeno un modello running, rossa se c'è almeno un modello in errore oppure arancione se niente è running

• creare notifiche anche fuori dalla desktop app, così se un utente lancia il modello, e contnua a lavorare su altro fuori dalla desktop app maialLLM potrà ricevere una notifica a livello deksotp.
Appena avviato il provision del modello, si consiglierà l'utente di lasciare in background quella finestra e di tornarne in N minuti (stima di cui punto sopra) oppure semplicemnte attendere la notifica

# Wizard introduttivo
Creare wizard introduttivo per gli step necessari da mostrare alla prima apertura dell'app, seguendo i passi base come
1. Creare apikey HF (servirà per il download dei modelli open weights)
2. Creare apikey vast.ai (sarà la tua unica forma di pagamento, maiaLLM is free)

# refactor performance desktop app
Review and imrpove the Speed of the desktop app in terms of startup. It must be faster.

# Supported OS
* start to support MacOS as well for Linux and produce the related artifacts as we are doing for windows
* update the landing page in order to create a 2 select box to allow the users to select "MaiaLLm for (linux, windows, macOS) running (x86, arm64 if windows or linux | m series for MacOS)" and than the download button will allow to download the right latest artifact

# chat section
* Chat list inside the "Chat" secion must have the option to delete them


# configs section
Inside the user cofnigs of the desltop app, make the configs section collapsed by default to make it clear and cleaner fo UX.