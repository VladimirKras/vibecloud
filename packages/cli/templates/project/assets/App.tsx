import { Display, House, Moon, Sun } from "@gravity-ui/icons";
import { ActionBar } from "@gravity-ui/navigation";
import { Card, Flex, Icon, SegmentedRadioGroup, Text } from "@gravity-ui/uikit";
import type { ThemeController, ThemePreference } from "./hooks/useTheme";
import styles from "./App.module.css";

export function App({ theme }: { theme: ThemeController }) {
  return (
    <div className={styles.workspace}>
      <ActionBar aria-label="Page actions">
        <ActionBar.Section>
          <ActionBar.Group>
            <ActionBar.Item>
              <Flex alignItems="center" gap={2}>
                <Icon data={House} size={16} />
                <Text className={styles.appName} variant="subheader-1">{{PROJECT_NAME}}</Text>
              </Flex>
            </ActionBar.Item>
          </ActionBar.Group>
        </ActionBar.Section>
        <ActionBar.Section type="secondary">
          <ActionBar.Group>
            <ActionBar.Item spacing={false}>
              <ThemeSelector theme={theme} />
            </ActionBar.Item>
          </ActionBar.Group>
        </ActionBar.Section>
      </ActionBar>
      <main className={styles.page}>
        <Card className={styles.card} view="outlined">
          <Flex alignItems="flex-start" direction="column" gap={5}>
            <Text as="p" className={styles.label} color="secondary" variant="caption-2">
              Vibecloud · Gravity UI
            </Text>
            <Text as="h1" className={styles.title} variant="display-2">{{PROJECT_NAME}}</Text>
            <Text as="p" className={styles.copy} color="secondary" variant="body-2">
              Your application is ready. Replace this component with your product.
            </Text>
          </Flex>
        </Card>
      </main>
    </div>
  );
}

function ThemeSelector({ theme }: { theme: ThemeController }) {
  return (
    <SegmentedRadioGroup<ThemePreference>
      name="theme"
      size="m"
      value={theme.preference}
      onUpdate={theme.setPreference}
    >
      <SegmentedRadioGroup.Option
        value="light"
        title="Light theme"
        controlProps={{ "aria-label": "Light theme" }}
      >
        <Icon data={Sun} size={16} />
      </SegmentedRadioGroup.Option>
      <SegmentedRadioGroup.Option
        value="system"
        title="System theme"
        controlProps={{ "aria-label": "System theme" }}
      >
        <Icon data={Display} size={16} />
      </SegmentedRadioGroup.Option>
      <SegmentedRadioGroup.Option
        value="dark"
        title="Dark theme"
        controlProps={{ "aria-label": "Dark theme" }}
      >
        <Icon data={Moon} size={16} />
      </SegmentedRadioGroup.Option>
    </SegmentedRadioGroup>
  );
}
