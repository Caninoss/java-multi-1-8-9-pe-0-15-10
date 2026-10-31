# Java Multi 1.8.9 + PE 0.15.10

# LEIA PRIMEIRO / READ FIRST / LEER PRIMERO

## Português (Brasil)

### O que é?
Este pacote junta o servidor Minecraft PE 0.15.10 com uma ponte que permite jogadores Java 1.8.9 entrarem nele. Não é um plugin `.phar`; é um servidor completo com uma segunda parte para a conexão Java.

Você usa o painel da hospedagem para enviar os arquivos e iniciar o servidor. Não precisa instalar Ubuntu no seu computador.

### Como instalar em um painel Pelican, como o das imagens
1. Crie um servidor novo para testar ou faça backup do servidor atual antes de trocar arquivos.
2. Abra **Arquivos** no painel.
3. Envie o conteúdo da pasta `Java Multi 1.8.9 + PE 0.15.10` para a pasta principal do servidor. No mesmo nível devem ficar `servidor`, `bridge-java-pe` e `INICIAR-PE-E-PONTE.sh`. Não envie só a pasta `servidor`.
4. Abra **Inicialização**. Troque o comando atual do PocketMine pelo comando abaixo:

   ```bash
   bash ./INICIAR-PE-E-PONTE.sh
   ```

5. Salve a alteração e aperte **Iniciar**. Na primeira vez, o painel precisa ter internet para baixar as dependências da ponte.
6. Abra **Console** para ver o resultado. Quando estiver pronto, o console mostra que o Genisys terminou de iniciar e que a ponte está ouvindo jogadores Java.

### O que a hospedagem precisa permitir?
Antes de enviar, pergunte ao suporte se o plano permite executar o comando acima e oferece Node.js 18 ou mais novo, PHP 7 e conexões TCP e UDP. Se aparecer `Node.js not found`, peça ao suporte para habilitar Node.js. Alguns planos de PocketMine aceitam plugins, mas não permitem executar a ponte Node.js; nesses planos o conjunto não funciona.

### Portas e endereço dos jogadores
No painel, abra **Rede** e confira as portas reservadas. São necessárias duas:
- **Java 1.8.9:** uma porta TCP (o pacote usa `25565` como padrão).
- **PE/Bedrock 0.15.10:** uma porta UDP (o pacote usa `19132` como padrão).

Use o IP/domínio mostrado pelo painel. Os jogadores Java usam a porta TCP; os jogadores PE usam a porta UDP. Se o painel reservar portas diferentes, peça ao suporte para ajustar `servidor/server.properties` e `bridge-java-pe/config.json`. A porta que aparece ao lado do endereço no painel pode ser só a porta PE; confirme o protocolo e reserve outra porta TCP para Java.

### Para desligar ou resolver erro
Use **Parar** no painel. Se não iniciar, tire uma foto de **Console** e mostre ao suporte da hospedagem. Não apague os arquivos do servidor atual sem ter backup.

### Compatibilidade
O teste feito neste PC confirmou um jogador Java 1.8.x entrando no Genisys PE 0.15.10 pela ponte. A instalação neste painel de hospedagem ainda não foi testada; confirme os requisitos com o suporte.

## English

### What is this?
This package combines a Minecraft PE 0.15.10 server with a bridge that lets Java 1.8.9 players join it. It is not a `.phar` plugin; it is a full server plus a separate Java connection bridge.

Use the hosting control panel to upload and start the files. You do not need to install Ubuntu on your computer.

### Install it in a Pelican panel like the screenshots
1. Create a new test server, or back up your current server before replacing files.
2. Open **Files** in the panel.
3. Upload the contents of `Java Multi 1.8.9 + PE 0.15.10` into the server's main folder. `servidor`, `bridge-java-pe`, and `INICIAR-PE-E-PONTE.sh` must be side by side. Do not upload only `servidor`.
4. Open **Startup**. Replace the current PocketMine command with:

   ```bash
   bash ./INICIAR-PE-E-PONTE.sh
   ```

5. Save the change and click **Start**. On first startup, the panel needs internet access to download the bridge dependencies.
6. Open **Console** to see the result. When ready, the console reports that Genisys has started and the bridge is listening for Java players.

### What must the hosting provider support?
Before uploading, ask support whether the plan allows this startup command and provides Node.js 18 or newer, PHP 7, and TCP and UDP connections. If you see `Node.js not found`, ask support to enable Node.js. Some PocketMine plans allow plugins but do not allow the Node.js bridge; those plans will not run this package.

### Ports and player address
Open **Network** in the panel and check the assigned ports. You need two:
- **Java 1.8.9:** a TCP port (the package defaults to `25565`).
- **PE/Bedrock 0.15.10:** a UDP port (the package defaults to `19132`).

Use the IP/domain shown in the panel. Java players use the TCP port; PE players use the UDP port. If the panel assigns different ports, ask support to update `servidor/server.properties` and `bridge-java-pe/config.json`. The port shown beside the panel address may be only the PE port; confirm its protocol and reserve a separate TCP port for Java.

### Stop or fix an error
Click **Stop** in the panel. If it does not start, take a screenshot of **Console** and send it to the hosting provider's support. Do not delete current server files unless you have a backup.

### Compatibility
Testing on this PC confirmed a Java 1.8.x player joining Genisys PE 0.15.10 through the bridge. Installation on this hosting panel has not been tested; confirm the requirements with support.

## Español

### ¿Qué es?
Este paquete reúne un servidor Minecraft PE 0.15.10 y un puente para que jugadores Java 1.8.9 puedan entrar. No es un plugin `.phar`; es un servidor completo con otra parte para la conexión Java.

Usa el panel del hosting para subir e iniciar los archivos. No necesitas instalar Ubuntu en tu computadora.

### Instálalo en un panel Pelican como el de las imágenes
1. Crea un servidor nuevo para probar o haz una copia de seguridad del servidor actual antes de cambiar archivos.
2. Abre **Archivos** en el panel.
3. Sube el contenido de `Java Multi 1.8.9 + PE 0.15.10` a la carpeta principal del servidor. `servidor`, `bridge-java-pe` e `INICIAR-PE-E-PONTE.sh` deben quedar juntos. No subas solamente `servidor`.
4. Abre **Inicialización**. Reemplaza el comando actual de PocketMine por:

   ```bash
   bash ./INICIAR-PE-E-PONTE.sh
   ```

5. Guarda el cambio y pulsa **Iniciar**. La primera vez, el panel necesita internet para descargar las dependencias del puente.
6. Abre **Consola** para ver el resultado. Cuando esté listo, la consola indicará que Genisys inició y que el puente está esperando jugadores Java.

### ¿Qué debe permitir el hosting?
Antes de subir los archivos, pregunta al soporte si el plan permite ejecutar este comando y ofrece Node.js 18 o posterior, PHP 7 y conexiones TCP y UDP. Si aparece `Node.js not found`, pide al soporte que habilite Node.js. Algunos planes PocketMine aceptan plugins, pero no permiten ejecutar el puente Node.js; esos planes no sirven para este paquete.

### Puertos y dirección para los jugadores
Abre **Red** en el panel y revisa los puertos asignados. Necesitas dos:
- **Java 1.8.9:** un puerto TCP (el paquete usa `25565` por defecto).
- **PE/Bedrock 0.15.10:** un puerto UDP (el paquete usa `19132` por defecto).

Usa la IP/dominio que muestra el panel. Java usa el puerto TCP y PE usa el UDP. Si el panel asigna otros puertos, pide al soporte que ajuste `servidor/server.properties` y `bridge-java-pe/config.json`. El puerto que aparece junto a la dirección puede ser solo el de PE; confirma el protocolo y reserva otro puerto TCP para Java.

### Apagar o resolver un error
Pulsa **Parar** en el panel. Si no inicia, toma una captura de **Consola** y envíasela al soporte del hosting. No borres los archivos actuales del servidor sin tener una copia de seguridad.

### Compatibilidad
La prueba en este PC confirmó que un jugador Java 1.8.x entró a Genisys PE 0.15.10 mediante el puente. La instalación en este panel de hosting todavía no se ha probado; confirma los requisitos con soporte.

## Créditos / Credits / Créditos

- **PT:** Projeto organizado por **@caninosofc (YouTube)**. © 2026 @caninosofc cobre somente os materiais originais deste pacote, como este guia e sua organização. Genisys declara licença GNU GPL v3 ou posterior ([projeto original](https://github.com/iTXTech/Genisys)); a ponte se baseia no [Java-to-MCPE de Nezha](https://git.nezha.ac/Nezha/Java-to-MCPE-0.14.x-0.15.x). Os créditos e termos das bases originais continuam valendo.
- **EN:** Organized by **@caninosofc (YouTube)**. © 2026 @caninosofc covers only this package's original materials, such as this guide and its organization. Genisys states GNU GPL v3 or later ([upstream project](https://github.com/iTXTech/Genisys)); the bridge is based on [Nezha's Java-to-MCPE](https://git.nezha.ac/Nezha/Java-to-MCPE-0.14.x-0.15.x). Keep the original credits and terms.
- **ES:** Organizado por **@caninosofc (YouTube)**. © 2026 @caninosofc cubre únicamente los materiales originales de este paquete, como esta guía y su organización. Genisys indica licencia GNU GPL v3 o posterior ([proyecto original](https://github.com/iTXTech/Genisys)); el puente se basa en el [Java-to-MCPE de Nezha](https://git.nezha.ac/Nezha/Java-to-MCPE-0.14.x-0.15.x). Conserva los créditos y condiciones originales.