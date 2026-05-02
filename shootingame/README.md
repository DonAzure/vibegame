# 말로 하는 슈팅 게임

음성으로 비행기를 조종하는 세로 스크롤 슈팅 게임입니다. **음성 인식 기능 테스트·튜닝·성능 향상**을 목적으로 [vibegame](https://github.com/DonAzure/vibegame) 저장소의 `shootingame` 폴더에서 관리합니다.

## 개요

- **플랫폼**: 웹(HTML5 Canvas) 기반 + **Capacitor**로 Android 앱 패키징
- **조작**: 말로 **좌·우 이동**, **미사일 발사**, 메뉴·설정·이름 입력·예/아니오 응답 등 처리
- **게임**: 적과 탄막을 피하며 스테이지를 진행하고, 점수·리더보드(로컬 저장)

## 음성 인식이 동작하는 방식

우선순위는 대략 다음과 같습니다.

1. **Android 네이티브 브리지** (`MainActivity`의 `AndroidVoice` + `SpeechRecognizer`)  
   WebView에 주입되는 JavaScript 인터페이스로, 인식 결과는 `android-voice` 커스텀 이벤트로 게임에 전달됩니다. 한국어(`Locale.KOREA`)·부분 결과(partial) 등을 사용합니다.
2. **Capacitor Speech Recognition 플러그인** (`@capacitor-community/speech-recognition`)  
   네이티브 브리지가 없거나 비활성일 때 경로에 따라 사용될 수 있습니다.
3. **브라우저 Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`)  
   PC Chrome 등에서 파일 또는 로컬 서버로 열었을 때.

마이크 권한(`RECORD_AUDIO`)은 Android에서 앱 시작 시 요청됩니다.

## 기본 음성 키워드

로컬 스토리지에 저장되며, 설정 화면에서 바꿀 수 있습니다. 초기 기본값 예시는 다음과 같습니다.

| 동작 | 기본 키워드(예) |
|------|------------------|
| 왼쪽 이동 | 왼쪽 |
| 오른쪽 이동 | 오른쪽 |
| 발사 | 뿅 |
| 설정 메뉴 | 설정 |
| 예 / 아니오 | 예 / 아니오 |

과거 기본값(좌·우·발사)으로 저장된 데이터는 앱이 한 번 로드될 때 새 기본값으로 자동 전환될 수 있습니다.

## 프로젝트 구조

| 경로 | 설명 |
|------|------|
| `Jujufighter.html` | 게임·UI·음성 로직이 들어 있는 단일 소스 |
| `scripts/prepare-web.js` | `Jujufighter.html`을 `www/index.html`로 복사 (Capacitor `webDir`) |
| `www/` | 빌드/동기화용 웹 출력물 (`prepare:web` 후 생성·갱신) |
| `capacitor.config.ts` | 앱 ID `com.voice.shooter`, 웹 디렉터리 `www` |
| `android/` | Gradle·`MainActivity`(음성 브리지)·리소스 |

## 사전 요구 사항

- **Node.js** (npm 포함)
- Android 패키징 시: **JDK**, **Android SDK** (Android Studio 설치 권장), 기기 또는 에뮬레이터

## 개발·빌드 절차

작업 디렉터리는 항상 **`shootingame` 폴더**입니다.

```bash
cd shootingame
npm install
```

웹 자산 준비 후 Capacitor 동기화:

```bash
npm run cap:sync
```

Android Studio에서 열기:

```bash
npm run cap:open:android
```

디버그 APK만 Gradle로 빌드할 때(Windows):

```bash
npm run build:apk:debug
```

`android` 폴더의 `local.properties` 등은 기기별 생성 파일이므로 Git에는 포함하지 않는 것이 일반적입니다(이미 `.gitignore`로 제외된 항목 참고).

## 웹에서만 빠르게 확인할 때

`Jujufighter.html`을 Chrome에서 직접 열거나, 간단한 정적 서버로 `www` 또는 프로젝트 루트를 서빙할 수 있습니다. 마이크는 **HTTPS 또는 localhost** 환경에서 권한 요청이 안정적인 경우가 많습니다.

## 트러블슈팅 요약

- **인식이 자주 끊긴다 / partial이 멈춘다**  
  기기·WebView에 따라 Capacitor 플러그인 경로는 팝업 모드 등으로 고정되는 코드가 있을 수 있습니다. 네이티브 브리지 경로가 우선 활성화되는지 확인하세요.
- **권한이 안 뜬다**  
  앱 정보에서 마이크 권한을 허용했는지, 시스템 음성 인식 서비스가 꺼져 있지 않은지 확인합니다.
- **브라우저에서 미지원**  
  `SpeechRecognition` 미지원 브라우저에서는 안내 메시지가 표시됩니다. Chrome 최신 버전 또는 지원되는 환경을 사용하세요.

## 라이선스·저작권

별도 라이선스 파일이 없다면 저장소 소유자 정책에 따릅니다. 외부 배포 시 게임 에셋·상표 사용 범위를 확인하세요.
